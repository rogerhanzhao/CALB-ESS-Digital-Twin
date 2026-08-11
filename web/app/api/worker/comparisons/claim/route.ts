import { env } from "cloudflare:workers";
import {
  comparisonJobPayloadIsValid,
  parseWorkerIdentity,
  sha256Hex,
  workerRequestIsAuthorized,
} from "../../../../../lib/worker-api";

type ClaimCandidate = {
  id: string;
  payload_object_key: string;
  payload_checksum_sha256: string;
};

export async function POST(request: Request) {
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
  if (!identity) return Response.json({ error: "invalid worker claim" }, { status: 400 });

  const now = new Date();
  const nowText = now.toISOString();
  const candidate = await env.DB.prepare(
    `SELECT id, payload_object_key, payload_checksum_sha256
       FROM study_comparisons
      WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < ?)
      ORDER BY created_at
      LIMIT 1`,
  ).bind(nowText).first<ClaimCandidate>();
  if (!candidate) return new Response(null, { status: 204 });
  if (candidate.payload_object_key !== `comparisons/${candidate.id}/job-payload.json`) {
    await failInvalidCandidate(candidate.id, "job payload pointer does not match comparison", nowText);
    return Response.json({ error: "queued comparison payload pointer is invalid" }, { status: 500 });
  }

  const leaseExpiresAt = new Date(now.getTime() + identity.leaseSeconds * 1000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE study_comparisons
        SET status = 'running', worker_id = ?, lease_expires_at = ?, heartbeat_at = ?,
            attempt = attempt + 1, updated_at = ?, error = NULL
      WHERE id = ?
        AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))`,
  ).bind(identity.workerId, leaseExpiresAt, nowText, nowText, candidate.id, nowText).run();
  if (claimed.meta.changes !== 1) {
    return Response.json({ error: "comparison was claimed concurrently" }, { status: 409 });
  }

  const object = await env.STUDY_ARTIFACTS.get(candidate.payload_object_key);
  if (!object) {
    await failClaim(candidate.id, identity.workerId, "job payload object is missing");
    return Response.json({ error: "claimed comparison payload is unavailable" }, { status: 500 });
  }
  const content = await object.arrayBuffer();
  if ((await sha256Hex(content)) !== candidate.payload_checksum_sha256) {
    await failClaim(candidate.id, identity.workerId, "job payload checksum mismatch");
    return Response.json({ error: "claimed comparison payload failed integrity validation" }, { status: 500 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(content));
  } catch {
    await failClaim(candidate.id, identity.workerId, "job payload is not valid JSON");
    return Response.json({ error: "claimed comparison payload is invalid" }, { status: 500 });
  }
  if (!comparisonJobPayloadIsValid(payload, candidate.id)) {
    await failClaim(candidate.id, identity.workerId, "job payload identity does not match comparison");
    return Response.json({ error: "claimed comparison payload identity is invalid" }, { status: 500 });
  }
  return Response.json({ job: payload, leaseExpiresAt });
}

async function failClaim(id: string, workerId: string, error: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE study_comparisons SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(error, now, id, workerId).run();
}

async function failInvalidCandidate(id: string, error: string, now: string) {
  await env.DB.prepare(
    `UPDATE study_comparisons SET status = 'failed', error = ?, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))`,
  ).bind(error, now, id, now).run();
}
