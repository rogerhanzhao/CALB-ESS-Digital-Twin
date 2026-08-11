/**
 * Evaluating a duty cycle against a calibration's validity envelope.
 *
 * `docs/architecture.md` section 3 says a run outside the calibrated range must be flagged
 * and must not support a warranty conclusion. That requires the boundary to be computable,
 * which is what `docs/test-data-import-and-quality-spec.md` section 7 specifies and what
 * the `calibrations` columns store.
 *
 * The verdict is deliberately three-valued. A dimension the envelope constrains but the
 * scenario does not describe cannot be checked, and reporting that as `true` would be the
 * exact failure the flag exists to prevent: a confident-looking pass that nobody computed.
 */

export type ValidityEnvelope = {
  /**
   * Cell temperature, per specification section 7 -- not ambient.
   *
   * The two are not interchangeable once heat generation and thermal management are in
   * play: a cell under load sits above the air around it. Judging a cell-temperature bound
   * by an ambient figure would mark a run inside the envelope while the cell it describes
   * was outside it.
   */
  cellTemperatureMinC: number | null;
  cellTemperatureMaxC: number | null;
  chargeRateMinC: number | null;
  chargeRateMaxC: number | null;
  dischargeRateMinC: number | null;
  dischargeRateMaxC: number | null;
  depthOfDischargeMin: number | null;
  depthOfDischargeMax: number | null;
  socMin: number | null;
  socMax: number | null;
  maxCalendarDays: number | null;
  maxCycles: number | null;
  maxEquivalentFullCycles: number | null;
};

/**
 * The duty cycle being checked.
 *
 * `cellTemperatureC`, `chargeRateC` and `dischargeRateC` are optional because no scenario
 * currently carries them: `ScenarioInput` in the contract has an ambient temperature and no
 * C-rate at all. They are declared here so the gap is typed and visible instead of silently
 * skipped, and an envelope that constrains them reports `unevaluated` until a scenario can
 * supply them.
 *
 * `ambientTemperatureC` is kept because it describes the study, but it is deliberately not
 * used to judge the cell-temperature bound. Substituting it would be a guess wearing the
 * costume of a measurement.
 */
export type DutyCycle = {
  ambientTemperatureC: number;
  cyclesPerDay: number;
  depthOfDischarge: number;
  socWindowMin: number;
  socWindowMax: number;
  horizonYears: number;
  cellTemperatureC?: number;
  chargeRateC?: number;
  dischargeRateC?: number;
};

export type EnvelopeVerdict = {
  /** true inside, false outside, null when some constrained dimension could not be checked. */
  within: boolean | null;
  breaches: string[];
  /** Dimensions the envelope constrains but the duty cycle does not describe. */
  unevaluated: string[];
};

const DAYS_PER_YEAR = 365;

/** Physical fractions are not exact decimals; see the SOC window note in `scenarios.ts`. */
const TOLERANCE = 1e-9;

/**
 * NaN is the only value that cannot be compared; infinities can.
 *
 * `Infinity > limit` is true and `-Infinity < limit` is true, so an infinite quantity has a
 * meaningful and correct verdict: it is outside any finite bound. NaN is different --
 * every comparison against it is false, so an unguarded check reads as "no breach" for a
 * value nobody could evaluate. Only that case is uncomputable.
 */
function comparable(value: number | undefined): value is number {
  return value !== undefined && !Number.isNaN(value);
}

/** A bound that is present must also be comparable; a NaN in a bound column is corrupt. */
function boundsUsable(min: number | null, max: number | null): boolean {
  return (min === null || !Number.isNaN(min)) && (max === null || !Number.isNaN(max));
}

function checkRange(
  label: string,
  value: number | undefined,
  min: number | null,
  max: number | null,
  breaches: string[],
  unevaluated: string[],
): void {
  if (min === null && max === null) return;
  if (!boundsUsable(min, max)) {
    unevaluated.push(`${label} (calibrated bound is not a comparable number)`);
    return;
  }
  // This guard is the difference between a computed pass and one that merely looks like it.
  if (!comparable(value)) {
    unevaluated.push(label);
    return;
  }
  if (min !== null && value < min - TOLERANCE) {
    breaches.push(`${label} ${value} is below the calibrated minimum ${min}`);
  }
  if (max !== null && value > max + TOLERANCE) {
    breaches.push(`${label} ${value} is above the calibrated maximum ${max}`);
  }
}

function checkCeiling(
  label: string,
  value: number,
  max: number | null,
  breaches: string[],
  unevaluated: string[],
): void {
  if (max === null) return;
  if (Number.isNaN(max)) {
    unevaluated.push(`${label} (calibrated bound is not a comparable number)`);
    return;
  }
  // Derived quantities inherit NaN from their inputs: a NaN horizon makes the exposure NaN,
  // and NaN > limit is false. Same trap as above, one step removed.
  if (!comparable(value)) {
    unevaluated.push(label);
    return;
  }
  if (value > max + TOLERANCE) {
    breaches.push(`${label} ${value} exceeds the calibrated maximum ${max}`);
  }
}

export function evaluateValidityEnvelope(
  envelope: ValidityEnvelope,
  duty: DutyCycle,
): EnvelopeVerdict {
  const breaches: string[] = [];
  const unevaluated: string[] = [];

  checkRange("cell temperature", duty.cellTemperatureC, envelope.cellTemperatureMinC, envelope.cellTemperatureMaxC, breaches, unevaluated);
  checkRange("depth of discharge", duty.depthOfDischarge, envelope.depthOfDischargeMin, envelope.depthOfDischargeMax, breaches, unevaluated);
  checkRange("charge rate", duty.chargeRateC, envelope.chargeRateMinC, envelope.chargeRateMaxC, breaches, unevaluated);
  checkRange("discharge rate", duty.dischargeRateC, envelope.dischargeRateMinC, envelope.dischargeRateMaxC, breaches, unevaluated);

  // The whole operating window has to sit inside the calibrated one. Checking only the
  // midpoint, or only one edge, would pass a cycle that spends half its life outside.
  // Each edge is a one-sided range so it inherits the same NaN guards.
  checkRange("SOC window floor", duty.socWindowMin, envelope.socMin, null, breaches, unevaluated);
  checkRange("SOC window ceiling", duty.socWindowMax, null, envelope.socMax, breaches, unevaluated);

  // Exposure is what the study asks the fit to extrapolate over, so it is derived from the
  // horizon rather than read from a field.
  const calendarDays = duty.horizonYears * DAYS_PER_YEAR;
  checkCeiling("calendar exposure in days", calendarDays, envelope.maxCalendarDays, breaches, unevaluated);

  const cycles = duty.cyclesPerDay * calendarDays;
  checkCeiling("cycle count", cycles, envelope.maxCycles, breaches, unevaluated);

  // Equivalent full cycles, not raw cycles: 6000 cycles at 50% DoD is 3000 EFC, and a fit
  // bounded by throughput has no quarrel with the former.
  const equivalentFullCycles = cycles * duty.depthOfDischarge;
  checkCeiling("equivalent full cycles", equivalentFullCycles, envelope.maxEquivalentFullCycles, breaches, unevaluated);

  if (breaches.length > 0) return { within: false, breaches, unevaluated };
  if (unevaluated.length > 0) return { within: null, breaches, unevaluated };
  return { within: true, breaches, unevaluated };
}

/**
 * The value to store in `runs.within_validity_envelope`.
 *
 * Null is a real state, not a missing one: it says the question was asked and could not be
 * answered. A run carrying null must be treated like a run carrying false when a warranty
 * conclusion is at stake.
 */
export function envelopeFlagFor(verdict: EnvelopeVerdict): boolean | null {
  return verdict.within;
}
