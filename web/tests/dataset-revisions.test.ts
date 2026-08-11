import assert from "node:assert/strict";
import test from "node:test";

import { parseDatasetRevisionSubmission, parseValidationPolicyInput } from "../lib/dataset-revisions.ts";

test("validation policy requires explicit physically ordered bounds", () => {
  const valid = parseValidationPolicyInput({
    productId: "product-314ah", version: "policy-V1", voltageMinV: 2.5, voltageMaxV: 3.65,
    absoluteCurrentMaxA: 314, temperatureMinC: -20, temperatureMaxC: 55,
    irregularIntervalFraction: 0.1, gapIntervalMultiplier: 3,
  });
  assert.equal(valid.ok, true);
  assert.equal(parseValidationPolicyInput({
    ...(valid.ok ? valid.value : {}), voltageMinV: 3.65, voltageMaxV: 2.5,
  }).ok, false);
});

test("dataset revision submission preserves explicit mapping and sign convention", () => {
  const parsed = parseDatasetRevisionSubmission({
    datasetId: "dataset-1", validationPolicyId: "policy-1", revision: "revision-V1",
    mappingVersion: "mapping-V1", cleaningRuleVersion: "cleaning-V1", codeRevision: "abcdef1",
    currentSign: "discharge_positive",
    mappings: [
      { source_column: "time", canonical_column: "timestamp", source_unit: "iso8601" },
      { source_column: "voltage", canonical_column: "voltage_v", source_unit: "V" },
    ],
    cycleMetricPolicy: null,
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.currentSign, "discharge_positive");
});

test("cycle policy rejects unknown roles", () => {
  const parsed = parseDatasetRevisionSubmission({
    datasetId: "dataset-1", validationPolicyId: "policy-1", revision: "revision-V1",
    mappingVersion: "mapping-V1", cleaningRuleVersion: "cleaning-V1", codeRevision: "abcdef1",
    currentSign: "charge_positive",
    mappings: [{ source_column: "time", canonical_column: "timestamp", source_unit: "iso8601" }],
    cycleMetricPolicy: { step_roles: { charge: "charge", pulse: "pulse" }, full_cycle_sequence: ["charge", "discharge"] },
  });
  assert.equal(parsed.ok, false);
});
