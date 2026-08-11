import type { RunResult } from "@contracts/generated/contracts";
import jobSchema from "../../contracts/generated/job.schema.json" with { type: "json" };
import resultSchema from "../../contracts/generated/result.schema.json" with { type: "json" };
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateRunResultSchema = ajv.compile(resultSchema);
const validateJobPayloadSchema = ajv.compile(jobSchema);

export const STANDARD_STUDY_ARTIFACTS = [
  "manifest.json",
  "scenario-exposure.json",
  "soh-result.json",
  "study-request.json",
] as const;

export type StandardStudyArtifactKind = (typeof STANDARD_STUDY_ARTIFACTS)[number];

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

export function isArtifactKind(value: unknown): value is StandardStudyArtifactKind {
  return (STANDARD_STUDY_ARTIFACTS as readonly unknown[]).includes(value);
}

export function resultObjectKey(runId: string, kind: StandardStudyArtifactKind): string {
  return `runs/${runId}/results/${kind}`;
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
