import { env } from "cloudflare:workers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { engineeringReviews, runArtifacts, runs } from "../../../../../db/schema";
import { r2ObjectKeyFromUri } from "../../../../../lib/artifact-access";
import {
  evidenceAllowsEngineeringApproval,
  parseEngineeringReviewInput,
} from "../../../../../lib/engineering-review";
import { parseIdempotencyKey } from "../../../../../lib/runs";
import { sha256Hex } from "../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string }> };
type EvidenceRow = {
  kind: string;
  uri: string;
  sizeBytes: number | null;
  checksum: string | null;
};

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function GET(request: Request, { params }: Context) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;
  const [owned] = await getDb()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.userId, owner)))
    .limit(1);
  if (!owned) return Response.json({ error: "Run not found" }, { status: 404 });
  const reviews = await getDb()
    .select()
    .from(engineeringReviews)
    .where(and(eq(engineeringReviews.runId, id), eq(engineeringReviews.userId, owner)))
    .orderBy(asc(engineeringReviews.createdAt));
  return Response.json({ reviews });
}

export async function POST(request: Request, { params }: Context) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseEngineeringReviewInput(body);
  if (!parsed.ok) {
    return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  }
  const key = parseIdempotencyKey(request);
  if (!key.ok || !key.value) {
    return Response.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 });
  }
  const { id } = await params;
  const db = getDb();
  const [prior] = await db
    .select()
    .from(engineeringReviews)
    .where(and(eq(engineeringReviews.userId, owner), eq(engineeringReviews.idempotencyKey, key.value)))
    .limit(1);
  if (prior) {
    if (prior.runId !== id) {
      return Response.json({ error: "Idempotency key belongs to another run" }, { status: 409 });
    }
    return Response.json({ review: prior });
  }
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.userId, owner)))
    .limit(1);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  if (run.engine !== "standard-study" || run.status !== "completed") {
    return Response.json({ error: "Only a completed standard study can be reviewed" }, { status: 409 });
  }
  const evidence = await db
    .select({
      kind: runArtifacts.kind,
      uri: runArtifacts.uri,
      sizeBytes: runArtifacts.sizeBytes,
      checksum: runArtifacts.checksum,
    })
    .from(runArtifacts)
    .where(
      and(
        eq(runArtifacts.runId, id),
        inArray(runArtifacts.kind, ["manifest.json", "soh-result.json"]),
      ),
    );
  const byKind = new Map(evidence.map((item) => [item.kind, item]));
  const manifestRow = byKind.get("manifest.json");
  const sohRow = byKind.get("soh-result.json");
  if (!manifestRow || !sohRow) {
    return Response.json({ error: "Review evidence is incomplete" }, { status: 409 });
  }
  const [manifest, sohResult] = await Promise.all([
    verifiedJson(manifestRow),
    verifiedJson(sohRow),
  ]);
  if (!manifest.ok || !sohResult.ok) {
    return Response.json({ error: "Review evidence failed integrity validation" }, { status: 409 });
  }
  if (
    parsed.value.decision === "approved" &&
    (!run.withinValidityEnvelope || !evidenceAllowsEngineeringApproval(manifest.value, sohResult.value))
  ) {
    return Response.json(
      { error: "This evidence set is not eligible for engineering approval" },
      { status: 409 },
    );
  }
  const review = {
    id: crypto.randomUUID(),
    runId: id,
    userId: owner,
    idempotencyKey: key.value,
    decision: parsed.value.decision,
    comment: parsed.value.comment,
    reviewerId: owner,
    reviewerEmail: request.headers.get("oai-authenticated-user-email"),
    manifestChecksumSha256: manifestRow.checksum!,
    sohResultChecksumSha256: sohRow.checksum!,
    createdAt: new Date().toISOString(),
  };
  try {
    await db.insert(engineeringReviews).values(review);
  } catch {
    return Response.json({ error: "Review was recorded concurrently; retry with the same key" }, { status: 409 });
  }
  return Response.json({ review }, { status: 201 });
}

async function verifiedJson(
  artifact: EvidenceRow,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const key = r2ObjectKeyFromUri(artifact.uri);
  if (!key || artifact.sizeBytes === null || !artifact.checksum) return { ok: false };
  const object = await env.STUDY_ARTIFACTS.get(key);
  if (!object) return { ok: false };
  const content = await object.arrayBuffer();
  if (content.byteLength !== artifact.sizeBytes || (await sha256Hex(content)) !== artifact.checksum) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(content)) };
  } catch {
    return { ok: false };
  }
}
