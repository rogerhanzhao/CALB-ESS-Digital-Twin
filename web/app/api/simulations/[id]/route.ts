import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { runArtifacts, runs, scenarios } from "../../../../db/schema";
import { cancellability, deriveDemoView, toRunView } from "../../../../lib/runs";

type Context = { params: Promise<{ id: string }> };

function userId(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

function unauthorized() {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

async function loadOwnedRun(id: string, owner: string) {
  const db = getDb();
  const rows = await db
    .select({ run: runs, scenario: scenarios })
    .from(runs)
    .innerJoin(scenarios, eq(runs.scenarioId, scenarios.id))
    .where(and(eq(runs.id, id), eq(runs.userId, owner)))
    .limit(1);
  return rows[0] ?? null;
}

/** Fetch one run. Read-only, like the list endpoint. */
export async function GET(request: Request, { params }: Context) {
  const owner = userId(request);
  if (!owner) return unauthorized();

  const { id } = await params;
  const row = await loadOwnedRun(id, owner);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  const artifacts = await getDb()
    .select({
      kind: runArtifacts.kind,
      contentType: runArtifacts.contentType,
      sizeBytes: runArtifacts.sizeBytes,
      checksum: runArtifacts.checksum,
      createdAt: runArtifacts.createdAt,
    })
    .from(runArtifacts)
    .where(eq(runArtifacts.runId, id));
  return Response.json({
    simulation: deriveDemoView(toRunView(row.run, row.scenario)),
    provenance: {
      jobContractVersion: row.run.jobContractVersion,
      payloadChecksumSha256: row.run.payloadChecksumSha256,
      workerId: row.run.workerId,
      attempt: row.run.attempt,
      withinValidityEnvelope:
        row.run.withinValidityEnvelope === null ? null : row.run.withinValidityEnvelope === 1,
      error: row.run.error,
    },
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      href: `/api/simulations/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact.kind)}`,
    })),
  });
}

/**
 * Cancel a run.
 *
 * `status = 'cancelled'` is the one status transition owned by the control plane
 * rather than by the worker holding the lease (`docs/data-model.md`, write ownership).
 * Terminal runs are left untouched.
 */
export async function DELETE(request: Request, { params }: Context) {
  const owner = userId(request);
  if (!owner) return unauthorized();

  const { id } = await params;
  const row = await loadOwnedRun(id, owner);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  // Terminality is judged on the derived view, not the stored row — see
  // `cancellability` for why.
  const verdict = cancellability(toRunView(row.run, row.scenario));
  if (!verdict.cancellable) {
    return Response.json({ error: `run is already ${verdict.status}` }, { status: 409 });
  }

  const db = getDb();
  await db
    .update(runs)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(runs.id, id),
        eq(runs.userId, owner),
        inArray(runs.status, ["queued", "running"]),
      ),
    );

  const updated = await loadOwnedRun(id, owner);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ simulation: toRunView(updated.run, updated.scenario) });
}
