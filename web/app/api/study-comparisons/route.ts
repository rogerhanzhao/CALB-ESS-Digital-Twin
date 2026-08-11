import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { runArtifacts, runs, studyComparisons } from "../../../db/schema";
import { r2ObjectKeyFromUri } from "../../../lib/artifact-access";
import {
  canonicalJsonBytes,
  comparisonJobIsValid,
  comparisonRequestIsValid,
  parseComparisonSubmission,
} from "../../../lib/comparison-registry";
import { parseIdempotencyKey } from "../../../lib/runs";
import { sha256Hex } from "../../../lib/worker-api";

const STUDY_EVIDENCE_KINDS = [
  "manifest.json",
  "scenario-exposure.json",
  "soh-result.json",
  "study-request.json",
] as const;
const MAX_COMPARISON_PAYLOAD_BYTES = 20 * 1024 * 1024;

type ArtifactRow = {
  kind: string;
  uri: string;
  sizeBytes: number | null;
  checksum: string | null;
};

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const comparisons = await getDb()
    .select()
    .from(studyComparisons)
    .where(eq(studyComparisons.userId, owner))
    .orderBy(desc(studyComparisons.createdAt));
  return Response.json({ comparisons });
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseComparisonSubmission(body);
  if (!parsed.ok) {
    return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  }
  const idempotency = parseIdempotencyKey(request);
  if (!idempotency.ok || !idempotency.value) {
    return Response.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 });
  }
  const db = getDb();
  const [existing] = await db
    .select()
    .from(studyComparisons)
    .where(
      and(
        eq(studyComparisons.userId, owner),
        eq(studyComparisons.idempotencyKey, idempotency.value),
      ),
    )
    .limit(1);
  if (existing) return Response.json({ comparison: existing });

  const selectedRuns = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.userId, owner),
        eq(runs.engine, "standard-study"),
        eq(runs.status, "completed"),
        inArray(runs.id, [parsed.value.baselineRunId, parsed.value.currentRunId]),
      ),
    );
  if (selectedRuns.length !== 2) {
    return Response.json(
      { error: "Both comparison inputs must be owned, completed standard studies" },
      { status: 409 },
    );
  }
  const artifacts = await db
    .select({
      runId: runArtifacts.runId,
      kind: runArtifacts.kind,
      uri: runArtifacts.uri,
      sizeBytes: runArtifacts.sizeBytes,
      checksum: runArtifacts.checksum,
    })
    .from(runArtifacts)
    .where(inArray(runArtifacts.runId, [parsed.value.baselineRunId, parsed.value.currentRunId]));
  const baseline = await loadStudyEvidence(
    artifacts.filter((item) => item.runId === parsed.value.baselineRunId),
  );
  const current = await loadStudyEvidence(
    artifacts.filter((item) => item.runId === parsed.value.currentRunId),
  );
  if (!baseline.ok || !current.ok) {
    return Response.json({ error: "Standard-study evidence failed integrity validation" }, { status: 409 });
  }
  const comparisonRequest = {
    schema_version: "V0.2",
    comparison_version: parsed.value.comparisonVersion,
    baseline: baseline.value,
    current: current.value,
    policy: parsed.value.policy,
  };
  if (!comparisonRequestIsValid(comparisonRequest)) {
    return Response.json(
      { error: "Selected studies are not valid like-for-like comparison evidence" },
      { status: 409 },
    );
  }
  const comparisonId = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = {
    contract_version: "1.0",
    job_id: comparisonId,
    user_id: owner,
    engine: "study-comparison",
    model_version: "study-comparison-V0.2",
    code_revision: parsed.value.codeRevision,
    study_comparison_request: comparisonRequest,
    submitted_at: now,
  };
  if (!comparisonJobIsValid(payload)) {
    return Response.json({ error: "Comparison job contract validation failed" }, { status: 409 });
  }
  const payloadBytes = canonicalJsonBytes(payload);
  if (payloadBytes.byteLength > MAX_COMPARISON_PAYLOAD_BYTES) {
    return Response.json({ error: "Comparison evidence exceeds the 20 MiB job limit" }, { status: 413 });
  }
  const payloadBuffer = payloadBytes.buffer.slice(
    payloadBytes.byteOffset,
    payloadBytes.byteOffset + payloadBytes.byteLength,
  ) as ArrayBuffer;
  const checksum = await sha256Hex(payloadBuffer);
  const objectKey = `comparisons/${comparisonId}/job-payload.json`;
  await env.STUDY_ARTIFACTS.put(objectKey, payloadBytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { comparisonId, sha256: checksum },
  });
  const row = {
    id: comparisonId,
    userId: owner,
    idempotencyKey: idempotency.value,
    baselineRunId: parsed.value.baselineRunId,
    currentRunId: parsed.value.currentRunId,
    comparisonVersion: parsed.value.comparisonVersion,
    codeRevision: parsed.value.codeRevision,
    jobContractVersion: "1.0",
    payloadObjectKey: objectKey,
    payloadChecksumSha256: checksum,
    status: "queued",
    attempt: 0,
    leaseExpiresAt: null,
    heartbeatAt: null,
    workerId: null,
    error: null,
    finalCapacityDeltaFraction: null,
    maximumAbsoluteCapacityDeltaFraction: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(studyComparisons).values(row);
  } catch {
    await env.STUDY_ARTIFACTS.delete(objectKey);
    return Response.json({ error: "Comparison was submitted concurrently; retry with the same key" }, { status: 409 });
  }
  return Response.json({ comparison: row }, { status: 201 });
}

async function loadStudyEvidence(
  rows: ArtifactRow[],
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (
    rows.length !== STUDY_EVIDENCE_KINDS.length ||
    new Set(rows.map((item) => item.kind)).size !== STUDY_EVIDENCE_KINDS.length ||
    rows.some((item) => !STUDY_EVIDENCE_KINDS.includes(item.kind as (typeof STUDY_EVIDENCE_KINDS)[number]))
  ) {
    return { ok: false };
  }
  const values = new Map<string, unknown>();
  for (const row of rows) {
    const key = r2ObjectKeyFromUri(row.uri);
    if (!key || row.sizeBytes === null || !row.checksum) return { ok: false };
    const object = await env.STUDY_ARTIFACTS.get(key);
    if (!object) return { ok: false };
    const content = await object.arrayBuffer();
    if (content.byteLength !== row.sizeBytes || (await sha256Hex(content)) !== row.checksum) {
      return { ok: false };
    }
    try {
      values.set(row.kind, JSON.parse(new TextDecoder().decode(content)));
    } catch {
      return { ok: false };
    }
  }
  const request = values.get("study-request.json");
  if (!isRecord(request)) return { ok: false };
  return {
    ok: true,
    value: {
      request,
      artifact: {
        schema_version: "V0.2",
        study_version: request.study_version,
        result_version: request.result_version,
        exposure: values.get("scenario-exposure.json"),
        soh_result: values.get("soh-result.json"),
      },
      manifest: values.get("manifest.json"),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
