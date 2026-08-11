import { env } from "cloudflare:workers";
import { datasetRevisionResultObjectKey, isDatasetRevisionArtifactKind, isWorkerId, sha256Hex, workerRequestIsAuthorized } from "../../../../../../../lib/worker-api";
type Context = { params: Promise<{ id: string; kind: string }> };
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024; const SHA256 = /^[0-9a-f]{64}$/;
export async function PUT(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) return Response.json({ error: "worker authentication failed" }, { status: 401 });
  const workerId = request.headers.get("x-worker-id"); const supplied = request.headers.get("x-content-sha256");
  if (!isWorkerId(workerId) || !supplied || !SHA256.test(supplied)) return Response.json({ error: "invalid worker or checksum header" }, { status: 400 });
  const { id, kind } = await params; if (!isDatasetRevisionArtifactKind(kind)) return Response.json({ error: "unsupported revision artifact" }, { status: 400 });
  const expectedContentType = kind === "canonical.csv" ? "text/csv; charset=utf-8" : "application/json";
  if (request.headers.get("content-type") !== expectedContentType) return Response.json({ error: "artifact content type does not match kind" }, { status: 400 });
  const declared = Number(request.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return Response.json({ error: "artifact exceeds 25 MiB" }, { status: 413 });
  const owned = await env.DB.prepare("SELECT 1 AS owned FROM dataset_revisions WHERE id = ? AND worker_id = ? AND processing_status = 'running'").bind(id, workerId).first();
  if (!owned) return Response.json({ error: "worker does not own this running revision" }, { status: 409 });
  const content = await request.arrayBuffer(); if (content.byteLength > MAX_ARTIFACT_BYTES) return Response.json({ error: "artifact exceeds 25 MiB" }, { status: 413 });
  const checksum = await sha256Hex(content); if (checksum !== supplied) return Response.json({ error: "artifact checksum mismatch" }, { status: 400 });
  const objectKey = datasetRevisionResultObjectKey(id, kind);
  await env.STUDY_ARTIFACTS.put(objectKey, content, { httpMetadata: { contentType: expectedContentType }, customMetadata: { revisionId: id, kind, sha256: checksum } });
  return Response.json({ artifact: { kind, objectKey, contentType: expectedContentType, sizeBytes: content.byteLength, checksumSha256: checksum } });
}
