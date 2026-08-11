import { env } from "cloudflare:workers";
import {
  comparisonResultObjectKey,
  isComparisonArtifactKind,
  isWorkerId,
  sha256Hex,
  workerRequestIsAuthorized,
} from "../../../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string; kind: string }> };
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export async function PUT(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) {
    return Response.json({ error: "worker authentication failed" }, { status: 401 });
  }
  const workerId = request.headers.get("x-worker-id");
  const suppliedChecksum = request.headers.get("x-content-sha256");
  if (!isWorkerId(workerId) || !suppliedChecksum || !SHA256.test(suppliedChecksum)) {
    return Response.json({ error: "invalid worker or checksum header" }, { status: 400 });
  }
  const { id, kind } = await params;
  if (!isComparisonArtifactKind(kind)) {
    return Response.json({ error: "unsupported comparison artifact" }, { status: 400 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ARTIFACT_BYTES) {
    return Response.json({ error: "artifact exceeds the 10 MiB limit" }, { status: 413 });
  }
  const owner = await env.DB.prepare(
    "SELECT 1 AS owned FROM study_comparisons WHERE id = ? AND worker_id = ? AND status = 'running'",
  ).bind(id, workerId).first<{ owned: number }>();
  if (!owner) {
    return Response.json({ error: "worker does not own this running comparison" }, { status: 409 });
  }
  const content = await request.arrayBuffer();
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    return Response.json({ error: "artifact exceeds the 10 MiB limit" }, { status: 413 });
  }
  const checksum = await sha256Hex(content);
  if (checksum !== suppliedChecksum) {
    return Response.json({ error: "artifact checksum mismatch" }, { status: 400 });
  }
  const objectKey = comparisonResultObjectKey(id, kind);
  await env.STUDY_ARTIFACTS.put(objectKey, content, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { comparisonId: id, kind, sha256: checksum },
  });
  return Response.json({ artifact: { kind, objectKey, contentType: "application/json", sizeBytes: content.byteLength, checksumSha256: checksum } });
}
