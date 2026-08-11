import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateValidityEnvelope,
  type DutyCycle,
  type ValidityEnvelope,
} from "../lib/calibrations.ts";

const unconstrained: ValidityEnvelope = {
  cellTemperatureMinC: null,
  cellTemperatureMaxC: null,
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
  cellTemperatureMinC: 15,
  cellTemperatureMaxC: 35,
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

/** Satisfies the cell-temperature bound so other dimensions can be tested in isolation. */
const cellOk = { cellTemperatureC: 25 };

test("a duty cycle inside every constrained dimension is within", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk });
  assert.equal(verdict.within, true, verdict.breaches.join("; "));
  assert.deepEqual(verdict.breaches, []);
  assert.deepEqual(verdict.unevaluated, []);
});

test("an unconstrained envelope cannot be breached", () => {
  const verdict = evaluateValidityEnvelope(unconstrained, { ...duty, ambientTemperatureC: 55 });
  assert.equal(verdict.within, true);
});

test("cell temperature outside the calibrated range is a breach", () => {
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, cellTemperatureC: 40 }).within, false);
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, cellTemperatureC: 10 }).within, false);
});

// Ambient and cell temperature are not interchangeable: a cell under load sits above the air
// around it. Judging a cell bound by an ambient figure would mark a run inside the envelope
// while the cell it describes was outside it, so ambient alone leaves the dimension unknown.
test("ambient temperature alone does not satisfy a cell temperature bound", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ambientTemperatureC: 25 });
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.includes("cell temperature"), verdict.unevaluated.join("; "));
});

test("depth of discharge outside the calibrated range is a breach", () => {
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, depthOfDischarge: 0.1 }).within, false);
});

// Checking a midpoint, or only one edge, would pass a cycle that spends half its life
// outside the range the fit was ever exercised over.
test("the whole SOC window must sit inside the calibrated window", () => {
  const low = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, socWindowMin: 0.0, socWindowMax: 0.9 });
  assert.equal(low.within, false);
  assert.ok(low.breaches.some((b) => b.includes("floor")), low.breaches.join("; "));

  const high = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, socWindowMin: 0.1, socWindowMax: 1.0 });
  assert.equal(high.within, false);
  assert.ok(high.breaches.some((b) => b.includes("ceiling")), high.breaches.join("; "));
});

test("calendar exposure beyond the calibrated duration is a breach", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, horizonYears: 25 });
  assert.equal(verdict.within, false);
  assert.ok(verdict.breaches.some((b) => b.includes("calendar exposure")), verdict.breaches.join("; "));
});

test("cycle count beyond the calibrated maximum is a breach", () => {
  // 1.5/day over 20 years is 10950 cycles against a ceiling of 8000.
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, cyclesPerDay: 1.5 });
  assert.equal(verdict.within, false);
  assert.ok(verdict.breaches.some((b) => b.includes("cycle count")), verdict.breaches.join("; "));
});

// 6000 cycles at 50% DoD is 3000 EFC. A throughput-bounded fit has no quarrel with that,
// and counting raw cycles instead would reject it for no physical reason.
test("equivalent full cycles are scaled by depth, not counted raw", () => {
  const shallow = evaluateValidityEnvelope(
    { ...unconstrained, maxEquivalentFullCycles: 4000 },
    { ...duty, ...cellOk, cyclesPerDay: 0.822, depthOfDischarge: 0.5 },
  );
  assert.equal(shallow.within, true, shallow.breaches.join("; "));

  const deep = evaluateValidityEnvelope(
    { ...unconstrained, maxEquivalentFullCycles: 4000 },
    { ...duty, ...cellOk, cyclesPerDay: 0.822, depthOfDischarge: 1.0 },
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
  const verdict = evaluateValidityEnvelope(both, { ...duty, ...cellOk, cellTemperatureC: 45 });
  assert.equal(verdict.within, false);
  assert.ok(verdict.unevaluated.includes("charge rate"));
});

test("every breach is reported, not just the first", () => {
  const verdict = evaluateValidityEnvelope(envelope, {
    ...duty, cellTemperatureC: 45, depthOfDischarge: 0.1, horizonYears: 25,
  });
  assert.equal(verdict.within, false);
  assert.ok(verdict.breaches.length >= 3, verdict.breaches.join("; "));
});

// The boundary itself is inside. Rejecting a duty cycle that sits exactly on a stated limit
// would make every published envelope quietly narrower than it claims.
test("a value exactly on the boundary is inside", () => {
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, cellTemperatureC: 35 }).within, true);
  assert.equal(evaluateValidityEnvelope(envelope, { ...duty, cellTemperatureC: 15 }).within, true);
});

test("a NaN input is unevaluated rather than silently passing", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, cellTemperatureC: NaN });
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.includes("cell temperature"));
});

// Regression guards for a hole found in cross-review: every comparison with NaN is false, so
// the unguarded SOC and ceiling paths reported "no breach" and the verdict came back `true`
// with empty breaches and empty unevaluated -- a confident pass computed from garbage, which
// is precisely what the three-valued verdict exists to prevent.
test("NaN in the SOC window yields null, not a silent pass", () => {
  const verdict = evaluateValidityEnvelope(envelope, {
    ...duty, ...cellOk, socWindowMin: NaN, socWindowMax: NaN,
  });
  assert.equal(verdict.within, null);
  assert.deepEqual(verdict.breaches, []);
  assert.ok(verdict.unevaluated.length >= 2, verdict.unevaluated.join("; "));
});

test("NaN in a derived exposure quantity yields null, not a silent pass", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, horizonYears: NaN });
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.some((u) => u.includes("calendar exposure")), verdict.unevaluated.join("; "));
});

test("the exact reproduction from the review no longer returns within: true", () => {
  const verdict = evaluateValidityEnvelope(envelope, {
    ...duty, socWindowMin: NaN, socWindowMax: NaN, horizonYears: NaN,
  });
  assert.notEqual(verdict.within, true);
});

// An earlier version admitted infinities because they compare correctly -- which holds in
// only one direction. On a ceiling check `-Infinity > limit` is false, so a negative-infinite
// exposure produced no breach and the verdict came back `true` with nothing recorded: the
// same confident pass from garbage as the NaN hole, through a different door. Found in
// cross-review. Both signs are pinned here.
test("positive Infinity in a duty value is unevaluated, not a pass", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, horizonYears: Infinity });
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.some((u) => u.includes("calendar exposure")), verdict.unevaluated.join("; "));
});

test("negative Infinity in a duty value is unevaluated, not a pass", () => {
  const verdict = evaluateValidityEnvelope(envelope, { ...duty, ...cellOk, horizonYears: -Infinity });
  assert.notEqual(verdict.within, true);
  assert.equal(verdict.within, null);
  assert.deepEqual(verdict.breaches, []);
  assert.ok(verdict.unevaluated.some((u) => u.includes("calendar exposure")), verdict.unevaluated.join("; "));
});

test("the negative-Infinity reproduction from the review no longer passes", () => {
  const verdict = evaluateValidityEnvelope(
    { ...unconstrained, socMin: 0.05, socMax: 0.95, maxCalendarDays: 7300, maxCycles: 8000, maxEquivalentFullCycles: 7000 },
    { ...duty, horizonYears: -Infinity },
  );
  assert.notEqual(verdict.within, true);
});

test("an infinite calibration bound is corrupt, not unconstrained", () => {
  const verdict = evaluateValidityEnvelope(
    { ...unconstrained, maxCycles: Infinity },
    { ...duty, ...cellOk },
  );
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.some((u) => u.includes("not a finite number")), verdict.unevaluated.join("; "));
});

// A NaN stored in a bound column is corrupt data, not an absent constraint. Treating it as
// absent would quietly widen an approved envelope.
test("a non-finite calibration bound is uncomputable, not unconstrained", () => {
  const corrupt: ValidityEnvelope = { ...unconstrained, cellTemperatureMaxC: NaN };
  const verdict = evaluateValidityEnvelope(corrupt, { ...duty, cellTemperatureC: 25 });
  assert.equal(verdict.within, null);
  assert.ok(verdict.unevaluated.some((u) => u.includes("not a finite number")), verdict.unevaluated.join("; "));

  const corruptCeiling: ValidityEnvelope = { ...unconstrained, maxCycles: NaN };
  const ceilingVerdict = evaluateValidityEnvelope(corruptCeiling, { ...duty, ...cellOk });
  assert.equal(ceilingVerdict.within, null);
  assert.ok(ceilingVerdict.unevaluated.some((u) => u.includes("not a finite number")));
});
