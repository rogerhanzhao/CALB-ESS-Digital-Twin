type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type ValidationPolicyInput = {
  productId: string;
  version: string;
  voltageMinV: number;
  voltageMaxV: number;
  absoluteCurrentMaxA: number;
  temperatureMinC: number;
  temperatureMaxC: number;
  irregularIntervalFraction: number;
  gapIntervalMultiplier: number;
};

export type DatasetRevisionSubmission = {
  datasetId: string;
  validationPolicyId: string;
  revision: string;
  mappingVersion: string;
  cleaningRuleVersion: string;
  codeRevision: string;
  currentSign: "charge_positive" | "discharge_positive";
  mappings: Array<{ source_column: string; canonical_column: string; source_unit: string }>;
  cycleMetricPolicy: null | {
    step_roles: Record<string, "charge" | "rest" | "discharge">;
    full_cycle_sequence: Array<"charge" | "rest" | "discharge">;
  };
};

export function datasetRevisionRequestIsValid(value: unknown): boolean {
  return validateRequest(value);
}

export function datasetRevisionJobIsValid(value: unknown): boolean {
  return validateJob(value);
}

export function parseValidationPolicyInput(value: unknown): Validation<ValidationPolicyInput> {
  const body = record(value);
  if (!body) return { ok: false, errors: ["request body must be a JSON object"] };
  const errors: string[] = [];
  const productId = text(body.productId, "productId", errors, 120);
  const version = text(body.version, "version", errors, 80);
  const voltageMinV = finite(body.voltageMinV, "voltageMinV", errors);
  const voltageMaxV = finite(body.voltageMaxV, "voltageMaxV", errors);
  const absoluteCurrentMaxA = finite(body.absoluteCurrentMaxA, "absoluteCurrentMaxA", errors);
  const temperatureMinC = finite(body.temperatureMinC, "temperatureMinC", errors);
  const temperatureMaxC = finite(body.temperatureMaxC, "temperatureMaxC", errors);
  const irregularIntervalFraction = finite(body.irregularIntervalFraction, "irregularIntervalFraction", errors);
  const gapIntervalMultiplier = finite(body.gapIntervalMultiplier, "gapIntervalMultiplier", errors);
  if (voltageMinV !== null && voltageMaxV !== null && voltageMaxV <= voltageMinV) errors.push("voltageMaxV must exceed voltageMinV");
  if (temperatureMinC !== null && temperatureMaxC !== null && temperatureMaxC <= temperatureMinC) errors.push("temperatureMaxC must exceed temperatureMinC");
  if (absoluteCurrentMaxA !== null && absoluteCurrentMaxA <= 0) errors.push("absoluteCurrentMaxA must be positive");
  if (irregularIntervalFraction !== null && irregularIntervalFraction < 0) errors.push("irregularIntervalFraction must be non-negative");
  if (gapIntervalMultiplier !== null && gapIntervalMultiplier <= 1) errors.push("gapIntervalMultiplier must exceed 1");
  return errors.length ? { ok: false, errors } : { ok: true, value: {
    productId, version, voltageMinV: voltageMinV!, voltageMaxV: voltageMaxV!,
    absoluteCurrentMaxA: absoluteCurrentMaxA!, temperatureMinC: temperatureMinC!,
    temperatureMaxC: temperatureMaxC!, irregularIntervalFraction: irregularIntervalFraction!,
    gapIntervalMultiplier: gapIntervalMultiplier!,
  } };
}

export function parseDatasetRevisionSubmission(value: unknown): Validation<DatasetRevisionSubmission> {
  const body = record(value);
  if (!body) return { ok: false, errors: ["request body must be a JSON object"] };
  const errors: string[] = [];
  const datasetId = text(body.datasetId, "datasetId", errors, 120);
  const validationPolicyId = text(body.validationPolicyId, "validationPolicyId", errors, 120);
  const revision = text(body.revision, "revision", errors, 80);
  const mappingVersion = text(body.mappingVersion, "mappingVersion", errors, 80);
  const cleaningRuleVersion = text(body.cleaningRuleVersion, "cleaningRuleVersion", errors, 80);
  const codeRevision = text(body.codeRevision, "codeRevision", errors, 64);
  if (codeRevision.length > 0 && codeRevision.length < 7) errors.push("codeRevision must contain at least 7 characters");
  const currentSign = body.currentSign;
  if (currentSign !== "charge_positive" && currentSign !== "discharge_positive") errors.push("currentSign is invalid");
  const mappings: DatasetRevisionSubmission["mappings"] = [];
  if (!Array.isArray(body.mappings) || body.mappings.length === 0 || body.mappings.length > 40) errors.push("mappings must contain 1 to 40 entries");
  else for (const [index, item] of body.mappings.entries()) {
    const mapping = record(item);
    if (!mapping) { errors.push(`mappings[${index}] must be an object`); continue; }
    const local: string[] = [];
    const source_column = text(mapping.source_column, `mappings[${index}].source_column`, local, 120);
    const canonical_column = text(mapping.canonical_column, `mappings[${index}].canonical_column`, local, 120);
    const source_unit = text(mapping.source_unit, `mappings[${index}].source_unit`, local, 40);
    errors.push(...local);
    if (!local.length) mappings.push({ source_column, canonical_column, source_unit });
  }
  let cycleMetricPolicy: DatasetRevisionSubmission["cycleMetricPolicy"] = null;
  if (body.cycleMetricPolicy !== null && body.cycleMetricPolicy !== undefined) {
    const policy = record(body.cycleMetricPolicy);
    const roles = policy && record(policy.step_roles);
    const sequence = policy?.full_cycle_sequence;
    const allowed = new Set(["charge", "rest", "discharge"]);
    if (!roles || !Object.keys(roles).length || Object.values(roles).some((role) => !allowed.has(String(role))) ||
        !Array.isArray(sequence) || !sequence.length || sequence.some((role) => !allowed.has(String(role)))) {
      errors.push("cycleMetricPolicy must define step_roles and full_cycle_sequence");
    } else {
      cycleMetricPolicy = {
        step_roles: Object.fromEntries(Object.entries(roles).map(([key, role]) => [key, role as "charge" | "rest" | "discharge"])),
        full_cycle_sequence: sequence as Array<"charge" | "rest" | "discharge">,
      };
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: {
    datasetId, validationPolicyId, revision, mappingVersion, cleaningRuleVersion, codeRevision,
    currentSign: currentSign as DatasetRevisionSubmission["currentSign"], mappings, cycleMetricPolicy,
  } };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, key: string, errors: string[], max: number): string {
  if (typeof value !== "string" || !value.trim()) { errors.push(`${key} is required`); return ""; }
  if (value.trim().length > max) errors.push(`${key} must be at most ${max} characters`);
  return value.trim();
}
function finite(value: unknown, key: string, errors: string[]): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) { errors.push(`${key} must be finite`); return null; }
  return value;
}
import Ajv from "ajv";
import addFormats from "ajv-formats";
import jobSchema from "../../contracts/generated/dataset-revision-job.schema.json" with { type: "json" };
import requestSchema from "../../contracts/generated/dataset-revision-request.schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateJob = ajv.compile(jobSchema);
const validateRequest = ajv.compile(requestSchema);
