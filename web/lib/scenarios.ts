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
    | "ambient_temperature_c"
    | "cycles_per_day"
    | "depth_of_discharge"
    | "horizon_years"
    | "initial_soc"
    | "end_of_life_fraction"
    | "soc_window_min"
    | "soc_window_max"
  >]: { min: number; max: number };
};

/**
 * The numbers are restated here because TypeScript cannot read them from the Python model,
 * but they are not trusted on faith: `tests/contract-ranges.test.ts` reads
 * `contracts/generated/job.schema.json` and fails if any bound here disagrees with it.
 * Typing alone only kept the field names honest, which is what a review of this file caught.
 */
export const CONTRACT_RANGES: ContractRanges = {
  ambient_temperature_c: { min: -20, max: 60 },
  cycles_per_day: { min: 0, max: 3 },
  depth_of_discharge: { min: 0, max: 1 },
  horizon_years: { min: 1, max: 25 },
  initial_soc: { min: 0, max: 1 },
  end_of_life_fraction: { min: 0.5, max: 0.95 },
  soc_window_min: { min: 0, max: 1 },
  soc_window_max: { min: 0, max: 1 },
};

/** Opaque family identifier. Deliberately permissive about meaning, strict about shape. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

/**
 * Physical fractions are not exact decimals. `0.95 - 0.05` is 0.8999999999999999 in IEEE
 * 754, so an exact comparison rejects a 5-95% window at 90% depth -- the most ordinary
 * configuration there is. A rounding artifact must not read as an invalid scenario.
 */
const SOC_TOLERANCE = 1e-9;

/**
 * Note the absence of `version`. It is assigned by the server as one past the current
 * maximum for the code, so a caller cannot publish V9 and then later V1 for the same family
 * -- which the unique index alone permitted, since it only forbids repeating a version.
 */
export type StandardScenarioInput = {
  code: string;
  name: string;
  ambientTemperatureC: number;
  cyclesPerDay: number;
  depthOfDischarge: number;
  socWindowMin: number;
  socWindowMax: number;
  horizonYears: number;
  initialSoc: number;
  endOfLifeFraction: number;
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

  if (body.version !== undefined) {
    errors.push("version is assigned by the server and must not be supplied");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) errors.push("name is required and must be at most 120 characters");

  const ambientTemperatureC = numberIn(body, "ambientTemperatureC", CONTRACT_RANGES.ambient_temperature_c, errors);
  const cyclesPerDay = numberIn(body, "cyclesPerDay", CONTRACT_RANGES.cycles_per_day, errors);
  const depthOfDischarge = numberIn(body, "depthOfDischarge", CONTRACT_RANGES.depth_of_discharge, errors);
  const socWindowMin = numberIn(body, "socWindowMin", CONTRACT_RANGES.soc_window_min, errors);
  const socWindowMax = numberIn(body, "socWindowMax", CONTRACT_RANGES.soc_window_max, errors);
  const initialSoc = numberIn(body, "initialSoc", CONTRACT_RANGES.initial_soc, errors);
  const endOfLifeFraction = numberIn(body, "endOfLifeFraction", CONTRACT_RANGES.end_of_life_fraction, errors);

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

  // The declared start point has to sit inside the declared operating window, or the
  // scenario describes a cell that begins outside the range it claims to run in.
  if (Number.isFinite(initialSoc) && Number.isFinite(socWindowMin) && Number.isFinite(socWindowMax)) {
    if (initialSoc < socWindowMin - SOC_TOLERANCE || initialSoc > socWindowMax + SOC_TOLERANCE) {
      errors.push("initialSoc must lie within the declared SOC window");
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      code,
      name,
      ambientTemperatureC,
      cyclesPerDay,
      depthOfDischarge,
      socWindowMin,
      socWindowMax,
      horizonYears: horizonYears as number,
      initialSoc,
      endOfLifeFraction,
    },
  };
}

/**
 * Project a stored standard scenario onto the execution contract.
 *
 * This is the point of versioning scenarios at all: an approved result has to name the duty
 * cycle it was produced under, and that name is worthless if running it again requires
 * someone to supply values the record never held. Every field the contract requires comes
 * from the row -- nothing is defaulted at submission time, because a value invented at the
 * boundary would not be part of the version anyone approved.
 *
 * The SOC window arrives here from `ScenarioInput` (contract V2). Before that it was
 * control-plane metadata the compute plane could not accept, which is what made the
 * projection lossy in the first place.
 */
export function toScenarioInput(row: StoredStandardScenario): ScenarioInput {
  return {
    name: `${row.code} V${row.version}`,
    horizon_years: row.horizonYears,
    cycles_per_day: row.cyclesPerDay,
    depth_of_discharge: row.depthOfDischarge,
    soc_window_min: row.socWindowMin,
    soc_window_max: row.socWindowMax,
    ambient_temperature_c: row.ambientTemperatureC,
    initial_soc: row.initialSoc,
    end_of_life_fraction: row.endOfLifeFraction,
  };
}

/** The columns the projection reads. Structural, so it accepts a row or a parsed input. */
export type StoredStandardScenario = StandardScenarioInput & { version: number };
