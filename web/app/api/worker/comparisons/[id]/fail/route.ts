import { env } from "cloudflare:workers";
import { isWorkerId, workerRequestIsAuthorized } from "../../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) {
    return Response.json({ error: "worker authentication failed" }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null ||
      !isWorkerId((body as Record<string, unknown>).workerId) ||
      typeof (body as Record<string, unknown>).error !== "string" ||
      (body as Record<string, unknown>).error === "" ||
      ((body as Record<string, unknown>).error as string).length > 4000) {
    return Response.json({ error: "invalid worker failure" }, { status: 400 });
  }
  const { id } = await params;
  const now = new Date().toISOString();
  const failed = await env.DB.prepare(
    `UPDATE study_comparisons SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running'`,
  ).bind((body as { error: string }).error, now, id, (body as { workerId: string }).workerId).run();
  if (failed.meta.changes !== 1) {
    return Response.json({ error: "worker does not own this running comparison" }, { status: 409 });
  }
  return Response.json({ status: "failed" });
}
