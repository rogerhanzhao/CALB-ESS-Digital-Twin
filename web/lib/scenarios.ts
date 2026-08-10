import type { ScenarioInput } from "@contracts/generated/contracts";

/**
 * Validation for versioned standard scenarios.
 *
 * The numeric ranges below are not chosen here. They mirror `contracts/models.py::ScenarioInput`,
 * which is what the compute plane will actually accept; a scenario the control plane
 * blesses but the worker rejects is a scenario nobody can run. `ContractRanges` exists so
 * that intent is checked rather than asserted in a comment: it is typed against the
 * generated contract, so a field disappearing from `ScenarioInput` breaks this build.
 */
type ContractRanges = {
  [K in keyof Pick<
    ScenarioInput,
    "ambient_temperature_c" | "cycles_per_day" | "depth_of_discharge" | "horizon_years"
  >]: { min: number; max: number };
};

export const CONTRACT_RANGES: ContractRanges = {
  ambient_temperature_c: { min: -20, max: 60 },
  cycles_per_day: { min: 0, max: 3 },
  depth_of_discharge: { min: 0, max: 1 },
  horizon_years: { min: 1, max: 25 },
};

/** Opaque family identifier. Deliberately permissive about meaning, strict about shape. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

export type StandardScenarioInput = {
  code: string;
  version: number;
  name: string;
  ambientTemperatureC: number;
  cyclesPerDay: number;
  depthOfDischarge: number;
  socWindowMin: number;
  socWindowMax: number;
  horizonYears: number;
};

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function numberIn(
  body: Record<string, unknown>,
  key: string,
  range: { min: number; max: number },
  errors: string[],
): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${key} must be a finite number`);
    return NaN;
  }
  if (value < range.min || value > range.max) {
    errors.push(`${key} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

export function parseStandardScenarioInput(payload: unknown): Validation<StandardScenarioInput> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const body = payload as Record<string, unknown>;
  const errors: string[] = [];

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!CODE_PATTERN.test(code)) {
    errors.push("code must be 3-64 characters of A-Z, 0-9 and '-', starting alphanumeric");
  }

  const version = body.version;
  if (!Number.isInteger(version) || (version as number) < 1) {
    errors.push("version must be an integer of at least 1");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) errors.push("name is required and must be at most 120 characters");

  const ambientTemperatureC = numberIn(body, "ambientTemperatureC", CONTRACT_RANGES.ambient_temperature_c, errors);
  const cyclesPerDay = numberIn(body, "cyclesPerDay", CONTRACT_RANGES.cycles_per_day, errors);
  const depthOfDischarge = numberIn(body, "depthOfDischarge", CONTRACT_RANGES.depth_of_discharge, errors);
  const socWindowMin = numberIn(body, "socWindowMin", { min: 0, max: 1 }, errors);
  const socWindowMax = numberIn(body, "socWindowMax", { min: 0, max: 1 }, errors);

  const horizonYears = body.horizonYears;
  if (!Number.isInteger(horizonYears)) {
    errors.push("horizonYears must be an integer");
  } else {
    numberIn(body, "horizonYears", CONTRACT_RANGES.horizon_years, errors);
  }

  // A window that is inverted or empty describes no operating range at all, and DoD has to
  // fit inside whatever window is declared. Both are cheap to check here and impossible to
  // reconstruct later from a result that was already approved.
  //
  // The tolerance is not cosmetic. `0.95 - 0.05` is 0.8999999999999999 in IEEE 754, so an
  // exact comparison rejects a 5-95% window at 90% DoD -- the most ordinary configuration
  // there is. These are physical fractions, not exact decimals, and a rounding artifact
  // must not read as an invalid scenario.
  const SOC_TOLERANCE = 1e-9;
  if (Number.isFinite(socWindowMin) && Number.isFinite(socWindowMax)) {
    if (socWindowMin >= socWindowMax) {
      errors.push("socWindowMin must be strictly below socWindowMax");
    } else if (
      Number.isFinite(depthOfDischarge) &&
      depthOfDischarge > socWindowMax - socWindowMin + SOC_TOLERANCE
    ) {
      errors.push("depthOfDischarge cannot exceed the declared SOC window");
    }
  }

  // Mirrors ScenarioInput.cycling_requires_positive_depth: cycling to zero depth is not a
  // duty cycle, and the compute plane rejects it. Catching it here keeps the two consistent.
  if (cyclesPerDay > 0 && depthOfDischarge === 0) {
    errors.push("depthOfDischarge must be positive when cyclesPerDay is positive");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      code,
      version: version as number,
      name,
      ambientTemperatureC,
      cyclesPerDay,
      depthOfDischarge,
      socWindowMin,
      socWindowMax,
      horizonYears: horizonYears as number,
    },
  };
}
