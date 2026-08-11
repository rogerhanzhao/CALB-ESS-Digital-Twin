import { env } from "cloudflare:workers";
import { verifyDatasetRevisionEvidence } from "../../../../../../lib/dataset-revision-evidence";
import { parseDatasetRevisionWorkerCompletion, workerRequestIsAuthorized } from "../../../../../../lib/worker-api";
type Context = { params: Promise<{ id: string }> };
type Owned = { dataset_id: string; revision: string; code_revision: string };
export async function POST(request: Request, { params }: Context) {
  if (!(await workerRequestIsAuthorized(request, env.WORKER_API_TOKEN))) return Response.json({ error: "worker authentication failed" }, { status: 401 });
  let body: unknown; try { body = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const { id } = await params; const completion = parseDatasetRevisionWorkerCompletion(body, id);
  if (!completion) return Response.json({ error: "invalid worker completion" }, { status: 400 });
  const owned = await env.DB.prepare("SELECT dataset_id, revision, code_revision FROM dataset_revisions WHERE id = ? AND worker_id = ? AND processing_status = 'running'")
    .bind(id, completion.workerId).first<Owned>();
  if (!owned) return Response.json({ error: "worker does not own this running revision" }, { status: 409 });
  const contents: Record<string, ArrayBuffer> = {};
  for (const artifact of completion.artifacts) {
    const stored = await env.STUDY_ARTIFACTS.get(artifact.objectKey);
    if (!stored || stored.size !== artifact.sizeBytes || stored.customMetadata?.sha256 !== artifact.checksumSha256 || stored.customMetadata?.revisionId !== id || stored.customMetadata?.kind !== artifact.kind) return Response.json({ error: `stored artifact failed verification: ${artifact.kind}` }, { status: 409 });
    contents[artifact.kind] = await stored.arrayBuffer();
  }
  const evidence = await verifyDatasetRevisionEvidence(contents, completion, { revisionId: id, datasetId: owned.dataset_id, revision: owned.revision, codeRevision: owned.code_revision });
  if (!evidence.ok) return Response.json({ error: `revision evidence failed verification: ${evidence.reason}` }, { status: 409 });
  const now = new Date().toISOString();
  const statements = completion.artifacts.map((artifact) => env.DB.prepare(
    `INSERT INTO dataset_revision_artifacts(id, revision_id, kind, uri, content_type, size_bytes, checksum, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM dataset_revisions WHERE id = ? AND worker_id = ? AND processing_status = 'running'`,
  ).bind(crypto.randomUUID(), artifact.kind, `r2://STUDY_ARTIFACTS/${artifact.objectKey}`, artifact.contentType, artifact.sizeBytes, artifact.checksumSha256, now, id, completion.workerId));
  const canonical = completion.artifacts.find((item) => item.kind === "canonical.csv");
  const report = completion.artifacts.find((item) => item.kind === "validation-report.json")!;
  statements.push(env.DB.prepare(
    `UPDATE dataset_revisions SET processing_status = 'completed', validation_status = ?, output_uri = ?,
      output_checksum_sha256 = ?, row_count = ?, validation_report_uri = ?, total_absolute_throughput_ah = ?,
      total_equivalent_full_cycles = ?, lease_expires_at = NULL, heartbeat_at = ?, error = NULL
      WHERE id = ? AND worker_id = ? AND processing_status = 'running'`,
  ).bind(evidence.validationStatus, canonical ? `r2://STUDY_ARTIFACTS/${canonical.objectKey}` : null,
    evidence.outputChecksum, evidence.rowCount, `r2://STUDY_ARTIFACTS/${report.objectKey}`,
    evidence.totalThroughputAh, evidence.totalEfc, now, id, completion.workerId));
  const results = await env.DB.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) return Response.json({ error: "worker lost the revision before completion" }, { status: 409 });
  return Response.json({ status: "completed", artifactCount: completion.artifacts.length });
}
