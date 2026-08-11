import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  calibrationInputs,
  calibrations,
  datasetRevisions,
} from "../../../../../db/schema";

type Context = { params: Promise<{ id: string }> };

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function POST(request: Request, { params }: Context) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [calibration] = await db
    .select()
    .from(calibrations)
    .where(and(eq(calibrations.id, id), eq(calibrations.userId, owner)))
    .limit(1);
  if (!calibration) return Response.json({ error: "Calibration not found" }, { status: 404 });
  if (calibration.status === "approved") {
    return Response.json({ calibration }, { status: 200 });
  }
  if (calibration.status !== "under_review" || calibration.approvalEligible !== 1) {
    return Response.json(
      { error: "Calibration is not computationally eligible for approval" },
      { status: 409 },
    );
  }
  if (
    !calibration.artifactObjectKey ||
    !calibration.artifactChecksumSha256 ||
    calibration.artifactSizeBytes === null
  ) {
    return Response.json({ error: "Calibration artifact evidence is incomplete" }, { status: 409 });
  }
  const evidence = await db
    .select({ validationStatus: datasetRevisions.validationStatus })
    .from(calibrationInputs)
    .innerJoin(
      datasetRevisions,
      eq(calibrationInputs.datasetRevisionId, datasetRevisions.id),
    )
    .where(eq(calibrationInputs.calibrationId, id));
  if (!evidence.length || evidence.some((item) => item.validationStatus !== "pass")) {
    return Response.json(
      { error: "Every calibration input must pass validation before approval" },
      { status: 409 },
    );
  }
  const stored = await env.STUDY_ARTIFACTS.head(calibration.artifactObjectKey);
  if (
    !stored ||
    stored.size !== calibration.artifactSizeBytes ||
    stored.customMetadata?.sha256 !== calibration.artifactChecksumSha256 ||
    stored.customMetadata?.calibrationRowId !== id
  ) {
    return Response.json({ error: "Calibration artifact failed integrity checks" }, { status: 409 });
  }
  const updated = await db
    .update(calibrations)
    .set({ status: "approved" })
    .where(
      and(
        eq(calibrations.id, id),
        eq(calibrations.userId, owner),
        eq(calibrations.status, "under_review"),
      ),
    );
  if (updated.meta.changes !== 1) {
    return Response.json({ error: "Calibration status changed concurrently" }, { status: 409 });
  }
  return Response.json({ calibration: { ...calibration, status: "approved" } });
}
