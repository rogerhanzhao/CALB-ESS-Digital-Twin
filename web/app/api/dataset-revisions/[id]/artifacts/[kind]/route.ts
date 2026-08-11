import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { datasetRevisionArtifacts, datasetRevisions } from "../../../../../../db/schema";
import { r2ObjectKeyFromUri, sourceAttachmentDisposition } from "../../../../../../lib/artifact-access";
import { isDatasetRevisionArtifactKind, sha256Hex } from "../../../../../../lib/worker-api";
type Context = { params: Promise<{ id: string; kind: string }> };
export async function GET(request: Request, { params }: Context) {
  const owner = request.headers.get("oai-authenticated-user-id"); if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id, kind } = await params; if (!isDatasetRevisionArtifactKind(kind)) return Response.json({ error: "Artifact not found" }, { status: 404 });
  const [artifact] = await getDb().select({ uri: datasetRevisionArtifacts.uri, contentType: datasetRevisionArtifacts.contentType, sizeBytes: datasetRevisionArtifacts.sizeBytes, checksum: datasetRevisionArtifacts.checksum })
    .from(datasetRevisionArtifacts).innerJoin(datasetRevisions, eq(datasetRevisionArtifacts.revisionId, datasetRevisions.id))
    .where(and(eq(datasetRevisionArtifacts.revisionId, id), eq(datasetRevisionArtifacts.kind, kind), eq(datasetRevisions.userId, owner))).limit(1);
  if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
  const key = r2ObjectKeyFromUri(artifact.uri); if (!key) return Response.json({ error: "Artifact pointer is invalid" }, { status: 409 });
  const stored = await env.STUDY_ARTIFACTS.get(key); if (!stored) return Response.json({ error: "Artifact is unavailable" }, { status: 409 });
  const content = await stored.arrayBuffer(); if (content.byteLength !== artifact.sizeBytes || await sha256Hex(content) !== artifact.checksum) return Response.json({ error: "Artifact failed integrity validation" }, { status: 409 });
  return new Response(content, { headers: { "content-type": artifact.contentType, "content-length": String(content.byteLength), etag: `"${artifact.checksum}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": sourceAttachmentDisposition(kind) } });
}
