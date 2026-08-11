import { env } from "cloudflare:workers";
import { datasetRevisionJobPayloadIsValid, parseWorkerIdentity, sha256Hex, workerRequestIsAuthorized } from "../../../../../lib/worker-api";

type Candidate = { id: string; request_object_key: string; request_checksum_sha256: string; file_name: string; checksum_sha256: string; byte_count: number };

export async function POST(request: Request) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) return Response.json({ error: "worker authentication failed" }, { status: 401 });
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const identity = parseWorkerIdentity(body);
  if (!identity) return Response.json({ error: "invalid worker claim" }, { status: 400 });
  const now = new Date(); const nowText = now.toISOString();
  const candidate = await env.DB.prepare(
    `SELECT r.id, r.request_object_key, r.request_checksum_sha256,
            d.file_name, d.checksum_sha256, d.byte_count
       FROM dataset_revisions r JOIN test_datasets d ON d.id = r.dataset_id
      WHERE r.request_object_key IS NOT NULL AND r.request_checksum_sha256 IS NOT NULL
        AND d.storage_uri IS NOT NULL AND d.checksum_sha256 IS NOT NULL AND d.byte_count IS NOT NULL
        AND (r.processing_status = 'queued' OR (r.processing_status = 'running' AND r.lease_expires_at < ?))
      ORDER BY r.created_at LIMIT 1`,
  ).bind(nowText).first<Candidate>();
  if (!candidate) return new Response(null, { status: 204 });
  if (candidate.request_object_key !== `dataset-revisions/${candidate.id}/job-payload.json`) {
    await failInvalid(candidate.id, "job payload pointer does not match dataset revision", nowText);
    return Response.json({ error: "queued revision payload pointer is invalid" }, { status: 500 });
  }
  const leaseExpiresAt = new Date(now.getTime() + identity.leaseSeconds * 1000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE dataset_revisions SET processing_status = 'running', worker_id = ?, lease_expires_at = ?,
      heartbeat_at = ?, attempt = attempt + 1, error = NULL
      WHERE id = ? AND (processing_status = 'queued' OR (processing_status = 'running' AND lease_expires_at < ?))`,
  ).bind(identity.workerId, leaseExpiresAt, nowText, candidate.id, nowText).run();
  if (claimed.meta.changes !== 1) return Response.json({ error: "revision was claimed concurrently" }, { status: 409 });
  const stored = await env.STUDY_ARTIFACTS.get(candidate.request_object_key);
  if (!stored) return failClaim(candidate.id, identity.workerId, "job payload object is missing");
  const content = await stored.arrayBuffer();
  if (await sha256Hex(content) !== candidate.request_checksum_sha256) return failClaim(candidate.id, identity.workerId, "job payload checksum mismatch");
  let payload: unknown; try { payload = JSON.parse(new TextDecoder().decode(content)); } catch { return failClaim(candidate.id, identity.workerId, "job payload is invalid JSON"); }
  if (!datasetRevisionJobPayloadIsValid(payload, candidate.id) || !isRecord(payload) ||
      payload.source_file_name !== candidate.file_name || payload.source_checksum_sha256 !== candidate.checksum_sha256) {
    return failClaim(candidate.id, identity.workerId, "job payload source identity mismatch");
  }
  return Response.json({ job: payload, leaseExpiresAt, source: {
    downloadUrl: `/api/worker/dataset-revisions/${candidate.id}/source`, fileName: candidate.file_name,
    checksumSha256: candidate.checksum_sha256, sizeBytes: candidate.byte_count,
  } });
}

async function failClaim(id: string, workerId: string, error: string) {
  await env.DB.prepare("UPDATE dataset_revisions SET processing_status = 'failed', error = ?, lease_expires_at = NULL WHERE id = ? AND worker_id = ? AND processing_status = 'running'")
    .bind(error, id, workerId).run();
  return Response.json({ error: "claimed dataset revision failed integrity validation" }, { status: 500 });
}
async function failInvalid(id: string, error: string, now: string) {
  await env.DB.prepare("UPDATE dataset_revisions SET processing_status = 'failed', error = ? WHERE id = ? AND (processing_status = 'queued' OR (processing_status = 'running' AND lease_expires_at < ?))")
    .bind(error, id, now).run();
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
