import Ajv from "ajv";
import addFormats from "ajv-formats";
import manifestSchema from "../../contracts/generated/dataset-revision-manifest.schema.json" with { type: "json" };
import requestSchema from "../../contracts/generated/dataset-revision-request.schema.json" with { type: "json" };
import resultSchema from "../../contracts/generated/dataset-revision-result.schema.json" with { type: "json" };
import { sha256Hex, type DatasetRevisionWorkerCompletion } from "./worker-api.ts";

const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
const validateManifest = ajv.compile(manifestSchema); const validateRequest = ajv.compile(requestSchema); const validateResult = ajv.compile(resultSchema);

export async function verifyDatasetRevisionEvidence(
  contents: Record<string, ArrayBuffer>, completion: DatasetRevisionWorkerCompletion,
  expected: { revisionId: string; datasetId: string; revision: string; codeRevision: string },
): Promise<{ ok: true; rowCount: number; validationStatus: "pass" | "warning" | "reject"; outputChecksum: string | null; totalThroughputAh: number | null; totalEfc: number | null } | { ok: false; reason: string }> {
  for (const artifact of completion.artifacts) {
    const content = contents[artifact.kind];
    if (!content || content.byteLength !== artifact.sizeBytes || await sha256Hex(content) !== artifact.checksumSha256) return { ok: false, reason: `${artifact.kind} bytes differ from completion metadata` };
  }
  const request = json(contents["revision-request.json"]); const result = json(contents["dataset-revision-result.json"]);
  const manifest = json(contents["revision-manifest.json"]); const report = json(contents["validation-report.json"]);
  if (!validateRequest(request) || !isRecord(request)) return { ok: false, reason: "revision request contract is invalid" };
  if (!validateResult(result) || !isRecord(result)) return { ok: false, reason: "revision result contract is invalid" };
  if (!validateManifest(manifest) || !isRecord(manifest)) return { ok: false, reason: "revision manifest contract is invalid" };
  if (!isRecord(report)) return { ok: false, reason: "validation report is invalid" };
  if (request.revision_id !== expected.revisionId || request.dataset_id !== expected.datasetId || request.revision !== expected.revision || request.code_revision !== expected.codeRevision ||
      result.revision_id !== expected.revisionId || result.dataset_id !== expected.datasetId || result.revision !== expected.revision ||
      manifest.revision_id !== expected.revisionId || manifest.dataset_id !== expected.datasetId || manifest.revision !== expected.revision) return { ok: false, reason: "revision identities differ across queue and evidence" };
  if (result.validation_outcome !== completion.result.validation_outcome ||
      result.canonical_available !== completion.result.canonical_available || result.cycle_metrics_available !== completion.result.cycle_metrics_available ||
      manifest.validation_outcome !== result.validation_outcome || report.outcome !== result.validation_outcome ||
      manifest.source_sha256 !== result.source_sha256 || report.source_sha256 !== result.source_sha256 ||
      manifest.calibration_eligible !== (result.validation_outcome === "pass")) return { ok: false, reason: "revision outcome or source identity is inconsistent" };
  const records = Array.isArray(manifest.files) ? manifest.files : [];
  const expectedFiles = new Set<string>(completion.artifacts.map((item) => item.kind).filter((kind) => kind !== "revision-manifest.json"));
  if (records.length !== expectedFiles.size) return { ok: false, reason: "revision manifest file count is invalid" };
  for (const item of records) {
    if (!isRecord(item) || typeof item.file_name !== "string" || !expectedFiles.has(item.file_name) || typeof item.sha256 !== "string" || typeof item.byte_count !== "number") return { ok: false, reason: "revision manifest file record is invalid" };
    const content = contents[item.file_name]; if (!content || content.byteLength !== item.byte_count || await sha256Hex(content) !== item.sha256) return { ok: false, reason: `revision manifest mismatch: ${item.file_name}` };
  }
  const canonical = completion.artifacts.find((item) => item.kind === "canonical.csv");
  const metrics = completion.result.cycle_metrics_available ? json(contents["cycle-metrics.json"]) : null;
  if (metrics !== null && (!isRecord(metrics) || !nonnegative(metrics.total_absolute_throughput_ah) || !nonnegative(metrics.total_equivalent_full_cycles))) return { ok: false, reason: "cycle metrics summary is invalid" };
  if (!Number.isInteger(result.normalized_row_count) || (result.normalized_row_count as number) < 0) return { ok: false, reason: "normalized row count is invalid" };
  return { ok: true, rowCount: result.normalized_row_count as number, validationStatus: result.validation_outcome as "pass" | "warning" | "reject",
    outputChecksum: canonical?.checksumSha256 ?? null,
    totalThroughputAh: metrics ? metrics.total_absolute_throughput_ah as number : null,
    totalEfc: metrics ? metrics.total_equivalent_full_cycles as number : null };
}

function json(content: ArrayBuffer | undefined): unknown { if (!content) return null; try { return JSON.parse(new TextDecoder().decode(content)); } catch { return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonnegative(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
