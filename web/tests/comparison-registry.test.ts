import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, parseComparisonSubmission } from "../lib/comparison-registry.ts";

const valid = {
  baselineRunId: "baseline-run",
  currentRunId: "current-run",
  comparisonVersion: "comparison-V1",
  codeRevision: "compare123",
  policy: {
    capacity_delta_tolerance_fraction: 1e-9,
    elapsed_days_tolerance: 1e-9,
    absolute_throughput_ah_tolerance: 1e-6,
    cycle_count_tolerance: 1e-9,
    equivalent_full_cycles_tolerance: 1e-9,
  },
};

test("requires two different result runs and every explicit tolerance", () => {
  assert.equal(parseComparisonSubmission(valid).ok, true);
  assert.equal(parseComparisonSubmission({ ...valid, currentRunId: "baseline-run" }).ok, false);
  assert.equal(
    parseComparisonSubmission({ ...valid, policy: { ...valid.policy, cycle_count_tolerance: -1 } }).ok,
    false,
  );
});

test("comparison payload canonicalization is stable", () => {
  assert.deepEqual(canonicalJsonBytes(valid), canonicalJsonBytes(Object.fromEntries(Object.entries(valid).reverse())));
});
