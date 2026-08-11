import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  cellProducts,
  cellSamples,
  datasetRevisions,
  datasetValidationPolicies,
  testDatasets,
} from "../../../db/schema";
import { canonicalJsonBytes } from "../../../lib/comparison-registry";
import {
  datasetRevisionJobIsValid,
  datasetRevisionRequestIsValid,
  parseDatasetRevisionSubmission,
} from "../../../lib/dataset-revisions";
import { parseIdempotencyKey } from "../../../lib/runs";
import { sha256Hex } from "../../../lib/worker-api";

const MAX_JOB_BYTES = 1024 * 1024;

export async function GET(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const revisions = await getDb().select().from(datasetRevisions)
    .where(eq(datasetRevisions.userId, owner)).orderBy(desc(datasetRevisions.createdAt));
  return Response.json({ revisions: revisions.map(publicRevision) });
}

export async function POST(request: Request) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const idempotency = parseIdempotencyKey(request);
  if (!idempotency.ok || !idempotency.value) return Response.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseDatasetRevisionSubmission(body);
  if (!parsed.ok) return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  const db = getDb();
  const [existing] = await db.select().from(datasetRevisions).where(and(
    eq(datasetRevisions.userId, owner), eq(datasetRevisions.idempotencyKey, idempotency.value),
  )).limit(1);
  if (existing) return Response.json({ revision: publicRevision(existing) });

  const [evidence] = await db.select({
    datasetId: testDatasets.id, productId: testDatasets.productId, sampleId: testDatasets.sampleId,
    testType: testDatasets.testType, sourceLab: testDatasets.sourceLab,
    equipmentId: testDatasets.equipmentId, operator: testDatasets.operator,
    testStartedAt: testDatasets.testStartedAt, testEndedAt: testDatasets.testEndedAt,
    fileName: testDatasets.fileName, storageUri: testDatasets.storageUri,
    checksumSha256: testDatasets.checksumSha256, byteCount: testDatasets.byteCount,
    batchCode: cellSamples.batchCode, nominalCapacityAh: cellProducts.nominalCapacityAh,
    policyId: datasetValidationPolicies.id, policyVersion: datasetValidationPolicies.version,
    voltageMinV: datasetValidationPolicies.voltageMinV, voltageMaxV: datasetValidationPolicies.voltageMaxV,
    absoluteCurrentMaxA: datasetValidationPolicies.absoluteCurrentMaxA,
    temperatureMinC: datasetValidationPolicies.temperatureMinC, temperatureMaxC: datasetValidationPolicies.temperatureMaxC,
    irregularIntervalFraction: datasetValidationPolicies.irregularIntervalFraction,
    gapIntervalMultiplier: datasetValidationPolicies.gapIntervalMultiplier,
  }).from(testDatasets)
    .innerJoin(cellSamples, eq(testDatasets.sampleId, cellSamples.id))
    .innerJoin(cellProducts, eq(testDatasets.productId, cellProducts.id))
    .innerJoin(datasetValidationPolicies, and(
      eq(datasetValidationPolicies.id, parsed.value.validationPolicyId),
      eq(datasetValidationPolicies.productId, testDatasets.productId),
      eq(datasetValidationPolicies.userId, testDatasets.userId),
      eq(datasetValidationPolicies.status, "approved"),
    )).where(and(eq(testDatasets.id, parsed.value.datasetId), eq(testDatasets.userId, owner))).limit(1);
  if (!evidence || !evidence.storageUri || !evidence.checksumSha256 || evidence.byteCount === null) {
    return Response.json({ error: "Owned source evidence and an approved matching validation policy are required" }, { status: 409 });
  }
  if (!evidence.fileName.toLowerCase().endsWith(".csv")) {
    return Response.json({ error: "XLSX must first be converted to an immutable canonical CSV source" }, { status: 409 });
  }
  if (evidence.testType === "cycle_aging" && !parsed.value.cycleMetricPolicy) {
    return Response.json({ error: "Cycle ageing requires an explicit step-role policy" }, { status: 400 });
  }
  if (evidence.testType !== "cycle_aging" && parsed.value.cycleMetricPolicy) {
    return Response.json({ error: "Cycle metric policy is only valid for cycle ageing" }, { status: 400 });
  }
  const revisionId = crypto.randomUUID();
  const revisionRequest = {
    schema_version: "V0.2", revision_id: revisionId, dataset_id: evidence.datasetId,
    revision: parsed.value.revision, mapping_version: parsed.value.mappingVersion,
    cleaning_rule_version: parsed.value.cleaningRuleVersion, code_revision: parsed.value.codeRevision,
    manifest: {
      schema_version: "V0.2", product_id: evidence.productId, sample_id: evidence.sampleId,
      batch_code: evidence.batchCode, test_type: evidence.testType, source_lab: evidence.sourceLab,
      equipment_id: evidence.equipmentId, test_started_at: evidence.testStartedAt,
      test_ended_at: evidence.testEndedAt, file_name: evidence.fileName,
      file_sha256: evidence.checksumSha256, operator: evidence.operator, notes: null,
      current_sign: parsed.value.currentSign,
    },
    mappings: parsed.value.mappings,
    validation_policy: {
      voltage_min_v: evidence.voltageMinV, voltage_max_v: evidence.voltageMaxV,
      absolute_current_max_a: evidence.absoluteCurrentMaxA,
      temperature_min_c: evidence.temperatureMinC, temperature_max_c: evidence.temperatureMaxC,
      irregular_interval_fraction: evidence.irregularIntervalFraction,
      gap_interval_multiplier: evidence.gapIntervalMultiplier,
    },
    cycle_metric_policy: parsed.value.cycleMetricPolicy ? {
      nominal_capacity_ah: evidence.nominalCapacityAh,
      step_roles: parsed.value.cycleMetricPolicy.step_roles,
      full_cycle_sequence: parsed.value.cycleMetricPolicy.full_cycle_sequence,
    } : null,
  };
  if (!datasetRevisionRequestIsValid(revisionRequest)) return Response.json({ error: "Dataset revision request contract validation failed" }, { status: 409 });
  const now = new Date().toISOString();
  const job = {
    contract_version: "1.0", job_id: revisionId, user_id: owner,
    engine: "dataset-revision", model_version: "data-validation-V0.2",
    code_revision: parsed.value.codeRevision, source_file_name: evidence.fileName,
    source_checksum_sha256: evidence.checksumSha256,
    dataset_revision_request: revisionRequest, submitted_at: now,
  };
  if (!datasetRevisionJobIsValid(job)) return Response.json({ error: "Dataset revision job contract validation failed" }, { status: 409 });
  const bytes = canonicalJsonBytes(job);
  if (bytes.byteLength > MAX_JOB_BYTES) return Response.json({ error: "Dataset revision request exceeds 1 MiB" }, { status: 413 });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const checksum = await sha256Hex(buffer);
  const objectKey = `dataset-revisions/${revisionId}/job-payload.json`;
  await env.STUDY_ARTIFACTS.put(objectKey, bytes, { httpMetadata: { contentType: "application/json" }, customMetadata: { revisionId, sha256: checksum } });
  const row = {
    id: revisionId, userId: owner, datasetId: evidence.datasetId, revision: parsed.value.revision,
    mappingVersion: parsed.value.mappingVersion, cleaningRuleVersion: parsed.value.cleaningRuleVersion,
    codeRevision: parsed.value.codeRevision, outputUri: null, outputChecksumSha256: null,
    rowCount: null, validationStatus: "pending" as const, validationReportUri: null,
    jobContractVersion: "1.0", requestObjectKey: objectKey, requestChecksumSha256: checksum,
    processingStatus: "queued", attempt: 0, leaseExpiresAt: null, heartbeatAt: null,
    workerId: null, error: null, totalAbsoluteThroughputAh: null, totalEquivalentFullCycles: null,
    idempotencyKey: idempotency.value, createdAt: now,
  } as const;
  try { await db.insert(datasetRevisions).values(row); }
  catch { await env.STUDY_ARTIFACTS.delete(objectKey); return Response.json({ error: "Revision conflicts with an existing version or retry" }, { status: 409 }); }
  return Response.json({ revision: publicRevision(row) }, { status: 201 });
}

function publicRevision(revision: typeof datasetRevisions.$inferSelect | typeof datasetRevisions.$inferInsert) {
  const { requestObjectKey: _key, requestChecksumSha256: _checksum, idempotencyKey: _idempotency, ...safe } = revision;
  void _key; void _checksum; void _idempotency;
  return safe;
}
