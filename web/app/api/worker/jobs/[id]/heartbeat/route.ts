import { env } from "cloudflare:workers";
import { parseWorkerIdentity, workerRequestIsAuthorized } from "../../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) {
    return Response.json({ error: "worker authentication failed" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const identity = parseWorkerIdentity(body);
  if (!identity) return Response.json({ error: "invalid worker heartbeat" }, { status: 400 });

  const { id } = await params;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + identity.leaseSeconds * 1000).toISOString();
  const renewed = await env.DB.prepare(
    `UPDATE runs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running'`,
  )
    .bind(now.toISOString(), leaseExpiresAt, now.toISOString(), id, identity.workerId)
    .run();
  if (renewed.meta.changes !== 1) {
    return Response.json({ error: "worker does not own this running job" }, { status: 409 });
  }
  return Response.json({ leaseExpiresAt });
}
