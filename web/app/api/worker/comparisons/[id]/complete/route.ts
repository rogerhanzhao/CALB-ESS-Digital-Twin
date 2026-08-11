import { env } from "cloudflare:workers";
import { parseComparisonWorkerCompletion, workerRequestIsAuthorized } from "../../../../../../lib/worker-api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) {
    return Response.json({ error: "worker authentication failed" }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const { id } = await params;
  const completion = parseComparisonWorkerCompletion(body, id);
  if (!completion) return Response.json({ error: "invalid worker completion" }, { status: 400 });
  const owned = await env.DB.prepare(
    "SELECT 1 AS owned FROM study_comparisons WHERE id = ? AND worker_id = ? AND status = 'running'",
  ).bind(id, completion.workerId).first<{ owned: number }>();
  if (!owned) {
    return Response.json({ error: "worker does not own this running comparison" }, { status: 409 });
  }
  for (const artifact of completion.artifacts) {
    const stored = await env.STUDY_ARTIFACTS.head(artifact.objectKey);
    if (!stored || stored.size !== artifact.sizeBytes ||
        stored.customMetadata?.sha256 !== artifact.checksumSha256 ||
        stored.customMetadata?.comparisonId !== id ||
        stored.customMetadata?.kind !== artifact.kind) {
      return Response.json({ error: `stored artifact failed verification: ${artifact.kind}` }, { status: 409 });
    }
  }
  const now = new Date().toISOString();
  const statements = completion.artifacts.map((artifact) => env.DB.prepare(
    `INSERT INTO comparison_artifacts(id, comparison_id, kind, uri, content_type, size_bytes, checksum, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM study_comparisons
      WHERE id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(crypto.randomUUID(), artifact.kind, `r2://STUDY_ARTIFACTS/${artifact.objectKey}`,
    artifact.contentType, artifact.sizeBytes, artifact.checksumSha256, now, id, completion.workerId));
  statements.push(env.DB.prepare(
    `UPDATE study_comparisons
        SET status = 'completed', final_capacity_delta_fraction = ?,
            maximum_absolute_capacity_delta_fraction = ?, lease_expires_at = NULL,
            heartbeat_at = ?, error = NULL, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running'`,
  ).bind(completion.result.final_capacity_delta_fraction,
    completion.result.maximum_absolute_capacity_delta_fraction,
    now, now, id, completion.workerId));
  const results = await env.DB.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) {
    return Response.json({ error: "worker lost the comparison before completion" }, { status: 409 });
  }
  return Response.json({ status: "completed", artifactCount: completion.artifacts.length });
}
