import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { comparisonArtifacts, studyComparisons } from "../../../../../../db/schema";
import { artifactDownloadName, r2ObjectKeyFromUri } from "../../../../../../lib/artifact-access";
import { isComparisonArtifactKind, sha256Hex } from "../../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string; kind: string }> };

export async function GET(request: Request, { params }: Context) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id, kind } = await params;
  if (!isComparisonArtifactKind(kind)) {
    return Response.json({ error: "Artifact not found" }, { status: 404 });
  }
  const [artifact] = await getDb().select({
    uri: comparisonArtifacts.uri,
    contentType: comparisonArtifacts.contentType,
    sizeBytes: comparisonArtifacts.sizeBytes,
    checksum: comparisonArtifacts.checksum,
  }).from(comparisonArtifacts)
    .innerJoin(studyComparisons, eq(comparisonArtifacts.comparisonId, studyComparisons.id))
    .where(and(eq(comparisonArtifacts.comparisonId, id), eq(comparisonArtifacts.kind, kind), eq(studyComparisons.userId, owner)))
    .limit(1);
  if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
  const objectKey = r2ObjectKeyFromUri(artifact.uri);
  if (!objectKey || artifact.sizeBytes === null || !artifact.checksum) {
    return Response.json({ error: "Artifact metadata is incomplete" }, { status: 409 });
  }
  const stored = await env.STUDY_ARTIFACTS.get(objectKey);
  if (!stored) return Response.json({ error: "Artifact object is unavailable" }, { status: 409 });
  const content = await stored.arrayBuffer();
  if (content.byteLength !== artifact.sizeBytes || (await sha256Hex(content)) !== artifact.checksum) {
    return Response.json({ error: "Artifact failed integrity validation" }, { status: 409 });
  }
  const headers = new Headers({
    "content-type": artifact.contentType || "application/octet-stream",
    "content-length": String(content.byteLength),
    etag: `"${artifact.checksum}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  if (new URL(request.url).searchParams.get("download") === "1") {
    headers.set("content-disposition", `attachment; filename="${artifactDownloadName(kind)}"`);
  }
  return new Response(content, { headers });
}
