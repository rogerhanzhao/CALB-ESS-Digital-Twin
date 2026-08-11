import comparisonJobSchema from "../../contracts/generated/comparison-job.schema.json" with { type: "json" };
import comparisonRequestSchema from "../../contracts/generated/study-comparison-request.schema.json" with { type: "json" };
import Ajv from "ajv";
import addFormats from "ajv-formats";

export type ComparisonSubmission = {
  baselineRunId: string;
  currentRunId: string;
  comparisonVersion: string;
  codeRevision: string;
  policy: {
    capacity_delta_tolerance_fraction: number;
    elapsed_days_tolerance: number;
    absolute_throughput_ah_tolerance: number;
    cycle_count_tolerance: number;
    equivalent_full_cycles_tolerance: number;
  };
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateRequest = ajv.compile(comparisonRequestSchema);
const validateJob = ajv.compile(comparisonJobSchema);

export function parseComparisonSubmission(value: unknown): Parsed<ComparisonSubmission> {
  if (!isRecord(value)) return { ok: false, errors: ["request body must be a JSON object"] };
  const errors: string[] = [];
  const baselineRunId = identifier(value.baselineRunId);
  const currentRunId = identifier(value.currentRunId);
  const comparisonVersion = text(value.comparisonVersion, 120);
  const codeRevision = text(value.codeRevision, 64);
  if (!baselineRunId) errors.push("baselineRunId is required and must be at most 80 characters");
  if (!currentRunId) errors.push("currentRunId is required and must be at most 80 characters");
  if (baselineRunId && baselineRunId === currentRunId) errors.push("baseline and current runs must differ");
  if (!comparisonVersion) errors.push("comparisonVersion is required and must be at most 120 characters");
  if (!codeRevision || codeRevision.length < 7) errors.push("codeRevision must contain 7-64 characters");
  const policyNames = [
    "capacity_delta_tolerance_fraction",
    "elapsed_days_tolerance",
    "absolute_throughput_ah_tolerance",
    "cycle_count_tolerance",
    "equivalent_full_cycles_tolerance",
  ] as const;
  const rawPolicy = isRecord(value.policy) ? value.policy : {};
  const policy = {} as ComparisonSubmission["policy"];
  for (const name of policyNames) {
    const raw = rawPolicy[name];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      errors.push(`policy.${name} must be a finite non-negative number`);
    } else {
      policy[name] = raw;
    }
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { baselineRunId, currentRunId, comparisonVersion, codeRevision, policy } };
}

export function comparisonRequestIsValid(value: unknown): boolean {
  return validateRequest(value);
}

export function comparisonJobIsValid(value: unknown): boolean {
  return validateJob(value);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortJson(value))}\n`);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function identifier(value: unknown): string {
  return text(value, 80);
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const result = value.trim();
  return result && result.length <= maximum ? result : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
