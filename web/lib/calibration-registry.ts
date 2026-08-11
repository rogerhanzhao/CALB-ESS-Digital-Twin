import calibrationResultSchema from "../../contracts/generated/calibration-result.schema.json" with { type: "json" };
import Ajv from "ajv";
import addFormats from "ajv-formats";

export type CalibrationArtifact = {
  schema_version: "V0.2";
  calibration_id: string;
  model_version: string;
  code_revision: string;
  product_revision: string;
  dataset_revision_ids: string[];
  parameters: {
    calendar_coefficient_per_sqrt_day: number;
    throughput_coefficient_per_ah_power: number;
    throughput_exponent: number;
  };
  metrics: {
    training_rmse_fraction: number;
    validation_rmse_fraction: number;
    validation_max_absolute_error_fraction: number;
    jacobian_rank: number;
    jacobian_condition_number: number | null;
    solver_cost: number;
    solver_evaluations: number;
  };
  validity_envelope: {
    product_revision: string;
    temperature_min_c: number;
    temperature_max_c: number;
    charge_c_rate_min: number;
    charge_c_rate_max: number;
    discharge_c_rate_min: number;
    discharge_c_rate_max: number;
    depth_of_discharge_min: number;
    depth_of_discharge_max: number;
    mean_soc_min: number;
    mean_soc_max: number;
    training_maximum_elapsed_days: number;
    training_maximum_cycle_count: number;
    training_maximum_equivalent_full_cycles: number;
    training_maximum_absolute_throughput_ah: number;
    approved_extrapolation_limits: {
      maximum_elapsed_days: number;
      maximum_cycle_count: number;
      maximum_equivalent_full_cycles: number;
      maximum_absolute_throughput_ah: number;
    };
  };
  fit_converged: boolean;
  identifiable: boolean;
  parameters_at_bounds: boolean;
  meets_validation_limit: boolean;
  approval_eligible: boolean;
  warnings: string[];
  observation_fits: Array<{
    observation_id: string;
    split: "train" | "validation";
    measured_capacity_fraction: number;
    predicted_capacity_fraction: number;
    residual_fraction: number;
  }>;
};

export type CalibrationRegistration = {
  productId: string;
  artifact: CalibrationArtifact;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateArtifact = ajv.compile(calibrationResultSchema);

export function parseCalibrationRegistration(value: unknown): Parsed<CalibrationRegistration> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const productId = typeof value.productId === "string" ? value.productId.trim() : "";
  const errors: string[] = [];
  if (!productId || productId.length > 80) {
    errors.push("productId is required and must be at most 80 characters");
  }
  const parsedArtifact = parseCalibrationArtifact(value.artifact);
  if (!parsedArtifact.ok) errors.push(...parsedArtifact.errors);
  if (errors.length) return { ok: false, errors };
  const artifact = parsedArtifact.ok ? parsedArtifact.value : (value.artifact as CalibrationArtifact);
  return { ok: true, value: { productId, artifact } };
}

export function parseCalibrationArtifact(value: unknown): Parsed<CalibrationArtifact> {
  if (!validateArtifact(value)) {
    return {
      ok: false,
      errors: (validateArtifact.errors ?? []).map(
        (error) => `artifact${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      ),
    };
  }
  const artifact = value as CalibrationArtifact;
  if (artifact.dataset_revision_ids.length === 0) {
    return { ok: false, errors: ["artifact requires at least one dataset revision"] };
  }
  if (new Set(artifact.dataset_revision_ids).size !== artifact.dataset_revision_ids.length) {
    return { ok: false, errors: ["artifact dataset_revision_ids must be unique"] };
  }
  return { ok: true, value: artifact };
}

export function canonicalArtifactBytes(artifact: CalibrationArtifact): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortJson(artifact))}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
