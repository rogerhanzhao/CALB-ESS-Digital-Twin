import type { RunResult } from "@contracts/generated/contracts";
import jobSchema from "../../contracts/generated/job.schema.json" with { type: "json" };
import resultSchema from "../../contracts/generated/result.schema.json" with { type: "json" };
import comparisonJobSchema from "../../contracts/generated/comparison-job.schema.json" with { type: "json" };
import comparisonResultSchema from "../../contracts/generated/comparison-job-result.schema.json" with { type: "json" };
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateRunResultSchema = ajv.compile(resultSchema);
const validateJobPayloadSchema = ajv.compile(jobSchema);
const validateComparisonJobSchema = ajv.compile(comparisonJobSchema);
const validateComparisonResultSchema = ajv.compile(comparisonResultSchema);

export const STANDARD_STUDY_ARTIFACTS = [
  "manifest.json",
  "scenario-exposure.json",
  "soh-result.json",
  "study-request.json",
] as const;

export type StandardStudyArtifactKind = (typeof STANDARD_STUDY_ARTIFACTS)[number];

export const STUDY_COMPARISON_ARTIFACTS = [
  "comparison-manifest.json",
  "comparison-request.json",
  "comparison-result.json",
] as const;
export type StudyComparisonArtifactKind = (typeof STUDY_COMPARISON_ARTIFACTS)[number];

export type WorkerIdentity = {
  workerId: string;
  leaseSeconds: number;
};

export type UploadedArtifact = {
  kind: StandardStudyArtifactKind;
  objectKey: string;
  contentType: "application/json";
  sizeBytes: number;
  checksumSha256: string;
};

export type WorkerCompletion = {
  workerId: string;
  result: RunResult;
  artifacts: UploadedArtifact[];
};

export type ComparisonWorkerCompletion = {
  workerId: string;
  result: {
    contract_version: "1.0";
    job_id: string;
    engine: "study-comparison";
    model_version: "study-comparison-V0.2";
    code_revision: string;
    status: "completed";
    comparison_version: string;
    final_capacity_delta_fraction: number;
    maximum_absolute_capacity_delta_fraction: number;
    artifact_checksums: Record<string, string>;
  };
  artifacts: Array<{
    kind: StudyComparisonArtifactKind;
    objectKey: string;
    contentType: "application/json";
    sizeBytes: number;
    checksumSha256: string;
  }>;
};

const WORKER_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function workerRequestIsAuthorized(
  request: Request,
  expectedToken: string | undefined,
): Promise<boolean> {
  if (!expectedToken) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const [left, right] = await Promise.all([digestText(supplied), digestText(expectedToken)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function parseWorkerIdentity(value: unknown): WorkerIdentity | null {
  if (!isRecord(value)) return null;
  if (!isWorkerId(value.workerId)) return null;
  if (
    typeof value.leaseSeconds !== "number" ||
    !Number.isInteger(value.leaseSeconds) ||
    value.leaseSeconds < 15 ||
    value.leaseSeconds > 300
  ) {
    return null;
  }
  return { workerId: value.workerId, leaseSeconds: value.leaseSeconds };
}

export function standardStudyJobPayloadIsValid(value: unknown, runId: string): boolean {
  if (!validateJobPayloadSchema(value) || !isRecord(value)) return false;
  return (
    value.contract_version === "3.0" &&
    value.job_id === runId &&
    value.engine === "standard-study" &&
    value.scenario === null &&
    isRecord(value.standard_study_request)
  );
}

export function comparisonJobPayloadIsValid(value: unknown, comparisonId: string): boolean {
  return (
    validateComparisonJobSchema(value) &&
    isRecord(value) &&
    value.contract_version === "1.0" &&
    value.job_id === comparisonId &&
    value.engine === "study-comparison"
  );
}

export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && WORKER_ID.test(value);
}

export function parseWorkerCompletion(value: unknown, runId: string): WorkerCompletion | null {
  if (!isRecord(value) || typeof value.workerId !== "string" || !WORKER_ID.test(value.workerId)) {
    return null;
  }
  if (!isRunResult(value.result, runId)) return null;
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== STANDARD_STUDY_ARTIFACTS.length) {
    return null;
  }
  const artifacts: UploadedArtifact[] = [];
  for (const item of value.artifacts) {
    if (!isRecord(item) || !isArtifactKind(item.kind)) return null;
    if (
      typeof item.objectKey !== "string" ||
      item.objectKey !== resultObjectKey(runId, item.kind) ||
      item.contentType !== "application/json" ||
      typeof item.sizeBytes !== "number" ||
      !Number.isInteger(item.sizeBytes) ||
      item.sizeBytes < 0 ||
      typeof item.checksumSha256 !== "string" ||
      !SHA256.test(item.checksumSha256)
    ) {
      return null;
    }
    artifacts.push(item as UploadedArtifact);
  }
  if (new Set(artifacts.map((item) => item.kind)).size !== STANDARD_STUDY_ARTIFACTS.length) {
    return null;
  }
  if (!isRecord(value.result.artifact_checksums)) return null;
  for (const artifact of artifacts) {
    if (value.result.artifact_checksums[artifact.kind] !== artifact.checksumSha256) return null;
  }
  return { workerId: value.workerId, result: value.result, artifacts };
}

export function parseComparisonWorkerCompletion(
  value: unknown,
  comparisonId: string,
): ComparisonWorkerCompletion | null {
  if (!isRecord(value) || !isWorkerId(value.workerId) || !isRecord(value.result)) return null;
  if (
    !validateComparisonResultSchema(value.result) ||
    value.result.job_id !== comparisonId ||
    value.result.engine !== "study-comparison" ||
    value.result.status !== "completed"
  ) {
    return null;
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== STUDY_COMPARISON_ARTIFACTS.length) {
    return null;
  }
  const artifacts: ComparisonWorkerCompletion["artifacts"] = [];
  for (const item of value.artifacts) {
    if (!isRecord(item) || !isComparisonArtifactKind(item.kind)) return null;
    if (
      item.objectKey !== comparisonResultObjectKey(comparisonId, item.kind) ||
      item.contentType !== "application/json" ||
      typeof item.sizeBytes !== "number" ||
      !Number.isInteger(item.sizeBytes) ||
      item.sizeBytes < 0 ||
      typeof item.checksumSha256 !== "string" ||
      !SHA256.test(item.checksumSha256)
    ) {
      return null;
    }
    artifacts.push(item as ComparisonWorkerCompletion["artifacts"][number]);
  }
  if (new Set(artifacts.map((item) => item.kind)).size !== STUDY_COMPARISON_ARTIFACTS.length) {
    return null;
  }
  const checksums = value.result.artifact_checksums;
  if (!isRecord(checksums)) return null;
  for (const artifact of artifacts) {
    if (checksums[artifact.kind] !== artifact.checksumSha256) return null;
  }
  return value as ComparisonWorkerCompletion;
}

export function isArtifactKind(value: unknown): value is StandardStudyArtifactKind {
  return (STANDARD_STUDY_ARTIFACTS as readonly unknown[]).includes(value);
}

export function resultObjectKey(runId: string, kind: StandardStudyArtifactKind): string {
  return `runs/${runId}/results/${kind}`;
}

export function isComparisonArtifactKind(value: unknown): value is StudyComparisonArtifactKind {
  return (STUDY_COMPARISON_ARTIFACTS as readonly unknown[]).includes(value);
}

export function comparisonResultObjectKey(
  comparisonId: string,
  kind: StudyComparisonArtifactKind,
): string {
  return `comparisons/${comparisonId}/results/${kind}`;
}

export async function sha256Hex(content: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRunResult(value: unknown, runId: string): value is RunResult {
  if (!validateRunResultSchema(value) || !isRecord(value)) return false;
  return (
    value.contract_version === "2.0" &&
    value.job_id === runId &&
    value.engine === "standard-study" &&
    value.status === "completed" &&
    typeof value.model_version === "string" &&
    value.model_version.length > 0 &&
    typeof value.code_revision === "string" &&
    value.code_revision.length >= 7 &&
    (value.end_soh === null ||
      (typeof value.end_soh === "number" &&
        Number.isFinite(value.end_soh) &&
        value.end_soh >= 0 &&
        value.end_soh <= 1.1)) &&
    (value.within_validity_envelope === null ||
      typeof value.within_validity_envelope === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function digestText(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
