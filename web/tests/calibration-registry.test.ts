import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalArtifactBytes,
  parseCalibrationRegistration,
  type CalibrationArtifact,
} from "../lib/calibration-registry.ts";

const artifact: CalibrationArtifact = {
  schema_version: "V0.2",
  calibration_id: "calibration-001",
  model_version: "semi-empirical-baseline-1",
  code_revision: "abcdef1",
  product_revision: "product-revision-001",
  dataset_revision_ids: ["dataset-revision-001"],
  parameters: {
    calendar_coefficient_per_sqrt_day: 0.001,
    throughput_coefficient_per_ah_power: 0.0001,
    throughput_exponent: 0.7,
  },
  metrics: {
    training_rmse_fraction: 0.00001,
    validation_rmse_fraction: 0.00002,
    validation_max_absolute_error_fraction: 0.00003,
    jacobian_rank: 3,
    jacobian_condition_number: 12,
    solver_cost: 0.0001,
    solver_evaluations: 24,
  },
  validity_envelope: {
    product_revision: "product-revision-001",
    temperature_min_c: 15,
    temperature_max_c: 35,
    depth_of_discharge_min: 0.8,
    depth_of_discharge_max: 0.8,
    mean_soc_min: 0.5,
    mean_soc_max: 0.5,
    charge_c_rate_min: 0.5,
    charge_c_rate_max: 0.5,
    discharge_c_rate_min: 0.5,
    discharge_c_rate_max: 0.5,
    training_maximum_elapsed_days: 625,
    training_maximum_cycle_count: 400,
    training_maximum_equivalent_full_cycles: 200,
    training_maximum_absolute_throughput_ah: 800,
    approved_extrapolation_limits: {
      maximum_elapsed_days: 7300,
      maximum_cycle_count: 7300,
      maximum_equivalent_full_cycles: 6500,
      maximum_absolute_throughput_ah: 26000,
    },
  },
  fit_converged: true,
  identifiable: true,
  parameters_at_bounds: false,
  meets_validation_limit: true,
  approval_eligible: true,
  warnings: [],
  observation_fits: [],
};

test("accepts a complete V0.2 calibration artifact", () => {
  const parsed = parseCalibrationRegistration({ productId: "product-001", artifact });
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
});

test("requires unique dataset evidence", () => {
  for (const ids of [[], ["dataset-1", "dataset-1"]]) {
    const parsed = parseCalibrationRegistration({
      productId: "product-001",
      artifact: { ...artifact, dataset_revision_ids: ids },
    });
    assert.equal(parsed.ok, false);
  }
});

test("rejects artifacts outside the generated schema", () => {
  const parsed = parseCalibrationRegistration({
    productId: "product-001",
    artifact: { ...artifact, schema_version: "V0.1" },
  });
  assert.equal(parsed.ok, false);
});

test("canonical artifact bytes are stable across key order", () => {
  const reversed = Object.fromEntries(Object.entries(artifact).reverse()) as CalibrationArtifact;
  assert.deepEqual(canonicalArtifactBytes(reversed), canonicalArtifactBytes(artifact));
});
