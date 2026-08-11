import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateValidityEnvelope,
  type DutyCycle,
  type ValidityEnvelope,
} from "../lib/calibrations.ts";

const unconstrained: ValidityEnvelope = {
  temperatureMinC: null,
  temperatureMaxC: null,
  chargeRateMinC: null,
  chargeRateMaxC: null,
  dischargeRateMinC: null,
  dischargeRateMaxC: null,
  depthOfDischargeMin: null,
  depthOfDischargeMax: null,
  socMin: null,
  socMax: null,
  maxCalendarDays: null,
  maxCycles: null,
  maxEquivalentFullCycles: null,
};

const envelope: ValidityEnvelope = {
  ...unconstrained,
  temperatureMinC: 15,
  temperatureMaxC: 35,
  depthOfDischargeMin: 0.2,
  depthOfDischargeMax: 0.95,
  socMin: 0.05,
  socMax: 0.95,
  maxCalendarDays: 365 * 20,
  maxCycles: 8000,
  maxEquivalentFullCycles: 7000,
};

const duty: DutyCycle = {
  ambientTemperatureC: 25,
  cyclesPerDay: 1,
  depthOfDischarge: 0.9,
  socWindowMin: 0.05,
  socWindowMax: 0.95,
  horizonYears: 20,
};

test("a duty cycle inside every constrained dimension is within", () => {
  const verdict = evaluateValidityEnvelope(envelope, duty);
  assert.equal(verdict.within, true, verdict.breaches.join("; "));
  assert.deepEqual(verdict.breaches, []);
  assert.deepEqual(verdict.unevaluated, []);
});

test("an unconstrained envelope cannot be breached", () => {
  const verdict = evaluateValidityEnvelope(unconstrained, { ...duty, ambientTemperatureC: 55 });
  assert.equal(verdict.within, true);
});

test("temperature outside the calibrated range is a breach", () => {
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, ambientTemperatureC: 40 }).within, false);
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, ambientTemperatureC: 10 }).within, false);
});

test("depth of discharge outside the calibrated range is a breach", () => {
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, depthOfDischarge: 0.1 }).within, false);
});

// Checking a midpoint, or only one edge, would pass a cycle that spends half its life
// outside the range the fit was ever exercised over.
test("the whole SOC window must sit inside the calibrated window", () => {
  const low = evaluateValidityEnvelope(envelope, { ...duty, socWindowMin: 0.0, socWindowMax: 0.9 });
  assert.equal(low.within, false);
  assert.ok(low.breaches.some((b) => b.includes("floor")), low.breaches.join("; "));

  const high = evaluateValidityEnvelope(envelope, { ...duty, socWindowMin: 0.1, socWindowMax: 1.0 });
  assert.equal(high.within, false);
  assert.ok(high.breaches.some((b) => b.includes("ceiling")), high.breaches.join("; "));
});

test("calendar exposure beyond the calibrated duration is a breach", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, horizonYears: 25 });
  assert.equal(verdict.within, false);
  assert.ok(verdict.breaches.some((b) => b.includes("calendar exposure")), verdict.breaches.join("; "));
});

test("cycle count beyond the calibrated maximum is a breach", () => {
  // 1.5/day over 20 years is 10950 cycles against a ceiling of 8000.
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, cyclesPerDay: 1.5 });
  assert.equal(verdict.within, false);
  assert.ok(verdict.breaches.some((b) => b.includes("cycle count")), verdict.breaches.join("; "));
});

// 6000 cycles at 50% DoD is 3000 EFC. A throughput-bounded fit has no quarrel with that,
// and counting raw cycles instead would reject it for no physical reason.
test("equivalent full cycles are scaled by depth, not counted raw", () => {
  const shallow = evaluateValidityEnvelope(
    { ...unconstrained, maxEquivalentFullCycles: 4000 },
    { ...duty, cyclesPerDay: 0.822, depthOfDischarge: 0.5 },
  );
  assert.equal(shallow.within, true, shallow.breaches.join("; "));

  const deep = evaluateValidityEnvelope(
    { ...unconstrained, maxEquivalentFullCycles: 4000 },
    { ...duty, cyclesPerDay: 0.822, depthOfDischarge: 1.0 },
  );
  assert.equal(deep.within, false);
  assert.ok(deep.breaches.some((b) => b.includes("equivalent full cycles")), deep.breaches.join("; "));
});

// The point of the three-valued verdict: a constrained dimension the duty cycle cannot
// describe must never read as a pass.
test("a constrained dimension the duty cycle does not describe yields null, not true", () => {
  const rateBound: ValidityEnvelope = { ...unconstrained, chargeRateMaxC: 0.5 };
  const verdict = evaluateValidityEnvelope(rateBound, duty);
  assert.equal(verdict.within, null);
  assert.deepEqual(verdict.breaches, []);
  assert.deepEqual(verdict.unevaluated, ["charge rate"]);
});

test("supplying the missing dimension resolves the verdict", () => {
  const rateBound: ValidityEnvelope = { ...unconstrained, chargeRateMaxC: 0.5 };
  assert.equal(evaluateValidityEnvelope(rateBound, { ...duty, chargeRateC: 0.3 }).within, true);
  assert.equal(evaluateValidityEnvelope(rateBound, { ...duty, chargeRateC: 0.8 }).within, false);
});

// A real breach outranks an unknown: the run is out of range whatever the missing value was.
test("a breach outranks an unevaluated dimension", () => {
  const both: ValidityEnvelope = { ...envelope, chargeRateMaxC: 0.5 };
  const verdict = evaluateValidityEnvelope(both, { ...duty, ambientTemperatureC: 45 });
  assert.equal(verdict.within, false);
  assert.ok(verdict.unevaluated.includes("charge rate"));
});

test("every breach is reported, not just the first", () => {
  const verdict = evaluateValidityEnvelope(envelope, {
    ...duty, ambientTemperatureC: 45, depthOfDischarge: 0.1, horizonYears: 25,
  });
  assert.equal(verdict.within, false);
  assert.ok(verdict.breaches.length >= 3, verdict.breaches.join("; "));
});

// The boundary itself is inside. Rejecting a duty cycle that sits exactly on a stated limit
// would make every published envelope quietly narrower than it claims.
test("a value exactly on the boundary is inside", () => {
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, ambientTemperatureC: 35 }).within, true);
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, ambientTemperatureC: 15 }).within, true);
});

test("a NaN input is unevaluated rather than silently passing", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ambientTemperatureC: NaN });
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.includes("ambient temperature"));
});
