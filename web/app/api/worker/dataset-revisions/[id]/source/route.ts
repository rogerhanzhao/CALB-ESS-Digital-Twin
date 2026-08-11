import { env } from "cloudflare:workers";
import { r2ObjectKeyFromUri } from "../../../../../../lib/artifact-access";
import { isWorkerId, sha256Hex, workerRequestIsAuthorized } from "../../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string }> };
type Source = { storage_uri: string; source_content_type: string | null; byte_count: number; checksum_sha256: string };

export async function GET(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) return Response.json({ error: "worker authentication failed" }, { status: 401 });
  const workerId = request.headers.get("x-worker-id");
  if (!isWorkerId(workerId)) return Response.json({ error: "invalid worker header" }, { status: 400 });
  const { id } = await params;
  const source = await env.DB.prepare(
    `SELECT d.storage_uri, d.source_content_type, d.byte_count, d.checksum_sha256
       FROM dataset_revisions r JOIN test_datasets d ON d.id = r.dataset_id
      WHERE r.id = ? AND r.worker_id = ? AND r.processing_status = 'running'`,
  ).bind(id, workerId).first<Source>();
  if (!source) return Response.json({ error: "worker does not own this running revision" }, { status: 409 });
  const objectKey = r2ObjectKeyFromUri(source.storage_uri);
  if (!objectKey) return Response.json({ error: "source object pointer is invalid" }, { status: 409 });
  const stored = await env.STUDY_ARTIFACTS.get(objectKey);
  if (!stored) return Response.json({ error: "source object is unavailable" }, { status: 409 });
  const content = await stored.arrayBuffer();
  if (content.byteLength !== source.byte_count || await sha256Hex(content) !== source.checksum_sha256) {
    return Response.json({ error: "source object failed integrity validation" }, { status: 409 });
  }
  return new Response(content, { headers: {
    "content-type": source.source_content_type || "application/octet-stream",
    "content-length": String(content.byteLength), "cache-control": "private, no-store",
    etag: `"${source.checksum_sha256}"`, "x-content-type-options": "nosniff",
  } });
}
