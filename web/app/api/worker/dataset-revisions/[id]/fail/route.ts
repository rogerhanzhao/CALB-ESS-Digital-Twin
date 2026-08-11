import { env } from "cloudflare:workers";
import { isWorkerId, workerRequestIsAuthorized } from "../../../../../../lib/worker-api";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) return Response.json({ error: "worker authentication failed" }, { status: 401 });
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  if (!isRecord(body) || !isWorkerId(body.workerId) || typeof body.error !== "string" || !body.error || body.error.length > 4000) return Response.json({ error: "invalid worker failure" }, { status: 400 });
  const { id } = await params;
  const failed = await env.DB.prepare("UPDATE dataset_revisions SET processing_status = 'failed', error = ?, lease_expires_at = NULL WHERE id = ? AND worker_id = ? AND processing_status = 'running'")
    .bind(body.error, id, body.workerId).run();
  if (failed.meta.changes !== 1) return Response.json({ error: "worker does not own this running revision" }, { status: 409 });
  return Response.json({ status: "failed" });
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
