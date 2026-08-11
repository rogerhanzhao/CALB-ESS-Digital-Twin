import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_RANGES, parseStandardScenarioInput } from "../lib/scenarios.ts";

const valid = {
  code: "ESS-STD-BASELINE",
  name: "Baseline duty cycle",
  codeRevision: "abcdef1",
  ambientTemperatureC: 25,
  cellTemperatureC: 27,
  cyclesPerDay: 1,
  operatingAvailabilityFraction: 0.95,
  maxChargeCRate: 0.5,
  maxDischargeCRate: 0.5,
  depthOfDischarge: 0.9,
  socWindowMin: 0.05,
  socWindowMax: 0.95,
  horizonYears: 20,
  initialSoc: 0.5,
  endOfLifeFraction: 0.8,
};

function errorsFor(patch: Record<string, unknown>): string[] {
  const result = parseStandardScenarioInput({ ...valid, ...patch });
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
  return result.ok ? [] : result.errors;
}

test("accepts a well-formed standard scenario", () => {
  const result = parseStandardScenarioInput(valid);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
});

test("rejects non-object bodies", () => {
  for (const payload of [null, "scenario", 7, ["scenario"]]) {
    const result = parseStandardScenarioInput(payload);
    assert.equal(result.ok, false);
  }
});

// The code is an identifier, not a description. Lowercase and spaces are rejected so the
// same family cannot be registered twice under two spellings.
test("rejects codes that are not opaque stable identifiers", () => {
  for (const code of ["", "ab", "ess-std", "ESS STD", "-LEADING", "X".repeat(65)]) {
    assert.ok(errorsFor({ code }).some((e) => e.includes("code")), `accepted ${JSON.stringify(code)}`);
  }
});

// Version is assigned server-side so a caller cannot publish V9 and then V1 for the same
// family. Accepting a submitted version would make the sequence a claim rather than a fact.
test("rejects a caller-supplied version", () => {
  for (const version of [1, 9, 0, "2"]) {
    assert.ok(errorsFor({ version }).some((e) => e.includes("version")), `accepted ${JSON.stringify(version)}`);
  }
});

// Guards the property the whole file exists for: these bounds are the contract's, so a
// scenario the control plane accepts is one the compute plane will also accept.
test("numeric bounds match contracts/models.py ScenarioInput", () => {
  assert.deepEqual(CONTRACT_RANGES.ambient_temperature_c, { min: -20, max: 60 });
  assert.deepEqual(CONTRACT_RANGES.cycles_per_day, { min: 0, max: 3 });
  assert.deepEqual(CONTRACT_RANGES.depth_of_discharge, { min: 0, max: 1 });
  assert.deepEqual(CONTRACT_RANGES.horizon_years, { min: 1, max: 25 });
});

test("rejects values outside the contract ranges rather than clamping", () => {
  assert.ok(errorsFor({ ambientTemperatureC: 61 }).some((e) => e.includes("ambientTemperatureC")));
  assert.ok(errorsFor({ ambientTemperatureC: -21 }).some((e) => e.includes("ambientTemperatureC")));
  assert.ok(errorsFor({ cyclesPerDay: 3.5 }).some((e) => e.includes("cyclesPerDay")));
  assert.ok(errorsFor({ horizonYears: 26 }).some((e) => e.includes("horizonYears")));
  assert.ok(errorsFor({ horizonYears: 0 }).some((e) => e.includes("horizonYears")));
});

test("rejects non-finite numbers instead of storing NaN", () => {
  for (const bad of [NaN, Infinity, "25", true, {}]) {
    assert.ok(errorsFor({ ambientTemperatureC: bad }).some((e) => e.includes("ambientTemperatureC")));
  }
});

test("requires horizonYears to be an integer", () => {
  assert.ok(errorsFor({ horizonYears: 20.5 }).some((e) => e.includes("integer")));
});

test("requires the physical exposure fields needed by the SOH study", () => {
  for (const field of [
    "codeRevision",
    "cellTemperatureC",
    "operatingAvailabilityFraction",
    "maxChargeCRate",
    "maxDischargeCRate",
  ]) {
    assert.ok(errorsFor({ [field]: undefined }).some((e) => e.includes(field)));
  }
  assert.ok(
    errorsFor({ operatingAvailabilityFraction: 1.1 }).some((e) =>
      e.includes("operatingAvailabilityFraction"),
    ),
  );
});

// A SOC window that is inverted or empty describes no operating range, and a DoD wider than
// the window describes cycling the cell outside the range the scenario claims to define.
test("rejects an inverted or empty SOC window", () => {
  assert.ok(errorsFor({ socWindowMin: 0.9, socWindowMax: 0.2 }).some((e) => e.includes("socWindowMin")));
  assert.ok(errorsFor({ socWindowMin: 0.5, socWindowMax: 0.5 }).some((e) => e.includes("socWindowMin")));
});

test("rejects a depth of discharge wider than the declared SOC window", () => {
  const errors = errorsFor({ socWindowMin: 0.4, socWindowMax: 0.8, depthOfDischarge: 0.9 });
  assert.ok(errors.some((e) => e.includes("SOC window")), errors.join("; "));
});

// Mirrors ScenarioInput.cycling_requires_positive_depth on the contract side.
test("rejects cycling to zero depth, matching the contract validator", () => {
  const errors = errorsFor({ cyclesPerDay: 1, depthOfDischarge: 0 });
  assert.ok(errors.some((e) => e.includes("depthOfDischarge must be positive")), errors.join("; "));
});

test("allows a calendar-only scenario with no cycling and no depth", () => {
  const result = parseStandardScenarioInput({ ...valid, cyclesPerDay: 0, depthOfDischarge: 0 });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
});

test("reports every problem at once rather than the first", () => {
  const errors = errorsFor({ code: "bad", version: 3, name: "", horizonYears: 99 });
  assert.ok(errors.length >= 4, `expected several errors, got ${JSON.stringify(errors)}`);
});

// Regression guard: 0.95 - 0.05 is 0.8999999999999999 in IEEE 754, so an exact comparison
// rejected the most ordinary configuration there is. The window check carries a tolerance
// because these are physical fractions, not exact decimals.
test("accepts a 5-95% window at 90% depth despite floating point subtraction", () => {
  const result = parseStandardScenarioInput({
    ...valid, socWindowMin: 0.05, socWindowMax: 0.95, depthOfDischarge: 0.9,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
});

test("the tolerance does not admit a depth genuinely wider than the window", () => {
  const errors = errorsFor({ socWindowMin: 0.05, socWindowMax: 0.95, depthOfDischarge: 0.91 });
  assert.ok(errors.some((e) => e.includes("SOC window")), errors.join("; "));
});

test("requires initialSoc and endOfLifeFraction so the record is executable", () => {
  for (const field of ["initialSoc", "endOfLifeFraction"]) {
    assert.ok(errorsFor({ [field]: undefined }).some((e) => e.includes(field)), `omitted ${field} accepted`);
  }
  assert.ok(errorsFor({ endOfLifeFraction: 0.4 }).some((e) => e.includes("endOfLifeFraction")));
  assert.ok(errorsFor({ endOfLifeFraction: 0.99 }).some((e) => e.includes("endOfLifeFraction")));
});

// A start point outside the operating window describes a cell that begins outside the range
// the scenario claims to run in.
test("rejects an initialSoc outside the declared SOC window", () => {
  assert.ok(errorsFor({ initialSoc: 0.99 }).some((e) => e.includes("initialSoc")));
  assert.ok(errorsFor({ initialSoc: 0.01 }).some((e) => e.includes("initialSoc")));
});

test("accepts an initialSoc exactly on the window edge", () => {
  for (const initialSoc of [0.05, 0.95]) {
    const result = parseStandardScenarioInput({ ...valid, initialSoc });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
  }
});
