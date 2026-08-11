import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { testDatasets } from "../../../../../db/schema";
import { r2ObjectKeyFromUri, sourceAttachmentDisposition } from "../../../../../lib/artifact-access";
import { sha256Hex } from "../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;
  const [dataset] = await getDb().select({
    fileName: testDatasets.fileName,
    storageUri: testDatasets.storageUri,
    sourceContentType: testDatasets.sourceContentType,
    byteCount: testDatasets.byteCount,
    checksumSha256: testDatasets.checksumSha256,
  }).from(testDatasets).where(and(eq(testDatasets.id, id), eq(testDatasets.userId, owner))).limit(1);
  if (!dataset) return Response.json({ error: "Dataset not found" }, { status: 404 });
  const objectKey = r2ObjectKeyFromUri(dataset.storageUri ?? "");
  if (!objectKey || dataset.byteCount === null || !dataset.checksumSha256) {
    return Response.json({ error: "Source evidence is not available for this legacy dataset" }, { status: 409 });
  }
  const stored = await env.STUDY_ARTIFACTS.get(objectKey);
  if (!stored) return Response.json({ error: "Source evidence object is unavailable" }, { status: 409 });
  const content = await stored.arrayBuffer();
  if (content.byteLength !== dataset.byteCount || await sha256Hex(content) !== dataset.checksumSha256) {
    return Response.json({ error: "Source evidence failed integrity validation" }, { status: 409 });
  }
  const headers = new Headers({
    "content-type": dataset.sourceContentType || "application/octet-stream",
    "content-length": String(content.byteLength),
    etag: `"${dataset.checksumSha256}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": sourceAttachmentDisposition(dataset.fileName),
  });
  return new Response(content, { headers });
}
