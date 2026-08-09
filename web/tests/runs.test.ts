import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellability,
  deriveDemoView,
  parseCreateRunInput,
  parseIdempotencyKey,
  type RunView,
} from "../lib/runs.ts";

function errorsFor(payload: unknown): string[] {
  const result = parseCreateRunInput(payload);
  assert.equal(result.ok, false, "expected validation to fail");
  return result.ok ? [] : result.errors;
}

function valueOf(payload: unknown) {
  const result = parseCreateRunInput(payload);
  assert.equal(result.ok, true, `expected validation to pass: ${JSON.stringify(payload)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

test("parseCreateRunInput rejects non-object bodies", () => {
  for (const payload of [null, "run", 42, ["run"]]) {
    assert.ok(errorsFor(payload).length > 0);
  }
});

test("parseCreateRunInput requires a usable name", () => {
  assert.ok(errorsFor({}).some((e) => e.includes("name")));
  assert.ok(errorsFor({ name: "   " }).some((e) => e.includes("name")));
  assert.ok(errorsFor({ name: "x".repeat(121) }).some((e) => e.includes("120")));
});

test("parseCreateRunInput applies defaults for absent optional fields", () => {
  const value = valueOf({ name: "baseline" });
  assert.deepEqual(value, {
    name: "baseline",
    chemistry: "LFP",
    horizonYears: 20,
    cyclesPerDay: 1,
    depthOfDischarge: 0.9,
    ambientTemperatureC: 25,
    initialSoc: 0.5,
    eolFraction: 0.8,
  });
});

test("parseCreateRunInput enforces the chemistry whitelist", () => {
  assert.ok(errorsFor({ name: "n", chemistry: "NMC" }).some((e) => e.includes("chemistry")));
  assert.equal(valueOf({ name: "n", chemistry: "LFP" }).chemistry, "LFP");
});

// Regression guard for docs/design-review.md P1-3: V0.1 pushed `Number(undefined)`
// through Math.min/Math.max, so a malformed body reached the database as NaN.
test("parseCreateRunInput rejects non-finite numbers instead of storing NaN", () => {
  for (const bad of [NaN, Infinity, -Infinity, "20", true, {}]) {
    const errors = errorsFor({ name: "n", horizonYears: bad });
    assert.ok(errors.some((e) => e.includes("horizonYears")), `accepted ${String(bad)}`);
  }
});

// Only an omitted field defaults. An explicit null or empty string is a caller error:
// defaulting it would silently run a different simulation than the caller described.
test("parseCreateRunInput rejects explicit null and empty string", () => {
  for (const bad of [null, ""]) {
    assert.ok(
      errorsFor({ name: "n", horizonYears: bad }).some((e) => e.includes("horizonYears")),
      `accepted ${JSON.stringify(bad)} for horizonYears`,
    );
    assert.ok(
      errorsFor({ name: "n", chemistry: bad }).some((e) => e.includes("chemistry")),
      `accepted ${JSON.stringify(bad)} for chemistry`,
    );
  }
});

test("parseCreateRunInput defaults only when the field is omitted", () => {
  assert.equal(valueOf({ name: "n" }).horizonYears, 20);
  assert.equal(valueOf({ name: "n", horizonYears: undefined }).horizonYears, 20);
});

test("parseCreateRunInput error messages say how to get the default", () => {
  assert.ok(errorsFor({ name: "n", horizonYears: null }).some((e) => e.includes("omit the field")));
  assert.ok(errorsFor({ name: "n", chemistry: "NMC" }).some((e) => e.includes("omit the field")));
});

// Regression guard for docs/design-review.md P1-3: out-of-range input must be an
// error, not silently clamped into a different simulation than the caller asked for.
test("parseCreateRunInput rejects out-of-range values rather than clamping", () => {
  assert.ok(errorsFor({ name: "n", horizonYears: 40 }).some((e) => e.includes("between")));
  assert.ok(errorsFor({ name: "n", cyclesPerDay: 0 }).some((e) => e.includes("between")));
  assert.ok(errorsFor({ name: "n", initialSoc: 1.5 }).some((e) => e.includes("between")));
  assert.ok(errorsFor({ name: "n", eolFraction: 0.1 }).some((e) => e.includes("between")));
});

test("parseCreateRunInput requires horizonYears to be an integer", () => {
  assert.ok(errorsFor({ name: "n", horizonYears: 12.5 }).some((e) => e.includes("integer")));
});

test("parseCreateRunInput reports every problem at once", () => {
  const errors = errorsFor({ name: "", chemistry: "NMC", horizonYears: 99 });
  assert.ok(errors.length >= 3, `expected several errors, got ${JSON.stringify(errors)}`);
});

function keyRequest(headers: Record<string, string>) {
  return new Request("https://app.local/api/simulations", { method: "POST", headers });
}

test("parseIdempotencyKey reports an absent header as absent, not invalid", () => {
  const result = parseIdempotencyKey(keyRequest({}));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, null);
});

test("parseIdempotencyKey accepts and trims a usable key", () => {
  const result = parseIdempotencyKey(keyRequest({ "idempotency-key": "  abc-123  " }));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "abc-123");
});

// A caller that sent a key is relying on retry safety. Dropping a malformed key
// silently would surface as a duplicate run on the retry, which is the one moment
// the guarantee was supposed to hold.
test("parseIdempotencyKey rejects a malformed key rather than ignoring it", () => {
  for (const bad of ["", "   ", "k".repeat(201)]) {
    const result = parseIdempotencyKey(keyRequest({ "idempotency-key": bad }));
    assert.equal(result.ok, false, `accepted ${JSON.stringify(bad.slice(0, 12))}`);
  }
});

const baseView: RunView = {
  id: "run-1",
  scenarioId: "sc-1",
  name: "baseline",
  chemistry: "LFP",
  cellParamSetVersion: null,
  horizonYears: 20,
  cyclesPerDay: 1,
  depthOfDischarge: 0.9,
  ambientTemperatureC: 25,
  initialSoc: 0.5,
  eolFraction: 0.8,
  engine: "demo",
  modelVersion: null,
  codeRevision: null,
  status: "queued",
  progress: 0,
  endSoh: null,
  withinValidityEnvelope: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  demo: true,
};

const createdAtMs = Date.parse(baseView.createdAt);

// Regression guard for docs/design-review.md P0-2: the V0.1 read path advanced every
// row by wall clock, which would have raced a real worker's writes once connected.
test("deriveDemoView never touches rows owned by a compute worker", () => {
  const real: RunView = { ...baseView, engine: "pybamm", demo: false, progress: 12, status: "running" };
  assert.deepEqual(deriveDemoView(real, createdAtMs + 10_000_000), real);
});

test("deriveDemoView leaves terminal demo rows alone", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const done: RunView = { ...baseView, status, progress: 100, endSoh: 80.1 };
    assert.deepEqual(deriveDemoView(done, createdAtMs + 10_000_000), done);
  }
});

test("deriveDemoView advances demo rows monotonically with elapsed time", () => {
  const early = deriveDemoView(baseView, createdAtMs + 9_000);
  const later = deriveDemoView(baseView, createdAtMs + 90_000);
  assert.ok(later.progress > early.progress);
  assert.ok(early.progress >= 0 && later.progress <= 100);
});

test("deriveDemoView withholds an end-of-life value until the run reads complete", () => {
  const running = deriveDemoView(baseView, createdAtMs + 90_000);
  assert.equal(running.status, "running");
  assert.equal(running.endSoh, null);

  const finished = deriveDemoView(baseView, createdAtMs + 1_000_000);
  assert.equal(finished.status, "completed");
  assert.equal(finished.progress, 100);
  assert.ok(typeof finished.endSoh === "number");
});

test("deriveDemoView never regresses stored progress", () => {
  const stored: RunView = { ...baseView, progress: 55, status: "running" };
  assert.ok(deriveDemoView(stored, createdAtMs + 1_000).progress >= 55);
});

test("deriveDemoView tolerates a clock that runs behind the record", () => {
  assert.deepEqual(deriveDemoView(baseView, createdAtMs - 60_000), baseView);
});

// A demonstrator run reads as completed long before its stored status changes, because
// demonstrator progress is never persisted. Cancellation must agree with what the caller
// was shown, not with the stale stored row.
test("cancellability refuses a demo run that already reads as completed", () => {
  const stored: RunView = { ...baseView, status: "queued", progress: 0 };
  const verdict = cancellability(stored, createdAtMs + 1_000_000);
  assert.equal(verdict.cancellable, false);
  assert.equal(verdict.cancellable === false && verdict.status, "completed");
});

test("cancellability allows a demo run that is still in flight", () => {
  assert.equal(cancellability(baseView, createdAtMs + 90_000).cancellable, true);
});

test("cancellability refuses a run already in a terminal stored state", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const done: RunView = { ...baseView, status, progress: 100 };
    const verdict = cancellability(done, createdAtMs + 1_000_000);
    assert.equal(verdict.cancellable, false, `allowed cancelling a ${status} run`);
    assert.equal(verdict.cancellable === false && verdict.status, status);
  }
});

test("cancellability judges worker-owned runs on their stored status alone", () => {
  const real: RunView = { ...baseView, engine: "pybamm", demo: false, status: "running" };
  assert.equal(cancellability(real, createdAtMs + 10_000_000).cancellable, true);
});
