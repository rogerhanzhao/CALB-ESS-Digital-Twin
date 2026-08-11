import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { calibrations, cellProducts, runs, scenarios, standardScenarios } from "../../../db/schema";
import { parseCalibrationArtifact } from "../../../lib/calibration-registry";
import { parseIdempotencyKey, toRunView } from "../../../lib/runs";
import {
  parseStandardStudySubmission,
  standardStudyRequestIsValid,
} from "../../../lib/standard-study-publisher";
import { sha256Hex, standardStudyJobPayloadIsValid } from "../../../lib/worker-api";

function ownerOf(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseStandardStudySubmission(body);
  if (!parsed.ok) {
    return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  }
  const key = parseIdempotencyKey(request);
  if (!key.ok || !key.value) {
    return Response.json(
      { error: "A valid Idempotency-Key header is required for a standard study" },
      { status: 400 },
    );
  }
  const db = getDb();
  const [existing] = await db
    .select({ run: runs, scenario: scenarios })
    .from(runs)
    .innerJoin(scenarios, eq(runs.scenarioId, scenarios.id))
    .where(and(eq(runs.userId, owner), eq(runs.idempotencyKey, key.value)))
    .limit(1);
  if (existing) return Response.json({ simulation: toRunView(existing.run, existing.scenario) });

  const { standardScenarioId, calibrationId, studyStartDate } = parsed.value;
  const [standard] = await db
    .select()
    .from(standardScenarios)
    .where(
      and(
        eq(standardScenarios.id, standardScenarioId),
        eq(standardScenarios.userId, owner),
        eq(standardScenarios.status, "released"),
      ),
    )
    .limit(1);
  if (!standard) return Response.json({ error: "Released standard scenario not found" }, { status: 404 });
  if (
    !standard.codeRevision ||
    standard.cellTemperatureC === null ||
    standard.operatingAvailabilityFraction === null ||
    standard.maxChargeCRate === null ||
    standard.maxDischargeCRate === null
  ) {
    return Response.json({ error: "Released standard scenario is not executable" }, { status: 409 });
  }

  const [selected] = await db
    .select({ calibration: calibrations, product: cellProducts })
    .from(calibrations)
    .innerJoin(cellProducts, eq(calibrations.productId, cellProducts.id))
    .where(
      and(
        eq(calibrations.id, calibrationId),
        eq(calibrations.userId, owner),
        eq(calibrations.status, "approved"),
        eq(cellProducts.userId, owner),
        eq(cellProducts.status, "released"),
      ),
    )
    .limit(1);
  if (!selected) return Response.json({ error: "Approved calibration not found" }, { status: 404 });
  const { calibration, product } = selected;
  if (
    !calibration.artifactObjectKey ||
    !calibration.artifactChecksumSha256 ||
    calibration.artifactSizeBytes === null
  ) {
    return Response.json({ error: "Approved calibration has incomplete artifact evidence" }, { status: 409 });
  }
  const storedCalibration = await env.STUDY_ARTIFACTS.get(calibration.artifactObjectKey);
  if (!storedCalibration) {
    return Response.json({ error: "Approved calibration artifact is unavailable" }, { status: 409 });
  }
  const calibrationBytes = await storedCalibration.arrayBuffer();
  if (
    calibrationBytes.byteLength !== calibration.artifactSizeBytes ||
    (await sha256Hex(calibrationBytes)) !== calibration.artifactChecksumSha256
  ) {
    return Response.json({ error: "Approved calibration artifact failed integrity validation" }, { status: 409 });
  }
  let calibrationJson: unknown;
  try {
    calibrationJson = JSON.parse(new TextDecoder().decode(calibrationBytes));
  } catch {
    return Response.json({ error: "Approved calibration artifact is invalid JSON" }, { status: 409 });
  }
  const parsedCalibration = parseCalibrationArtifact(calibrationJson);
  if (
    !parsedCalibration.ok ||
    parsedCalibration.value.calibration_id !== calibration.artifactCalibrationId ||
    parsedCalibration.value.model_version !== calibration.modelVersion ||
    parsedCalibration.value.code_revision !== calibration.codeRevision ||
    parsedCalibration.value.product_revision !== product.revision
  ) {
    return Response.json({ error: "Approved calibration artifact identity is invalid" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const scenarioId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const versionLabel = `${standard.code}-V${standard.version}`;
  const scenario = {
    id: scenarioId,
    userId: owner,
    name: `${standard.name} · ${product.model} ${product.revision}`,
    chemistry: product.chemistry,
    cellParamSetVersion: parsedCalibration.value.calibration_id,
    standardScenarioId: standard.id,
    horizonYears: standard.horizonYears,
    cyclesPerDay: standard.cyclesPerDay,
    depthOfDischarge: standard.depthOfDischarge,
    ambientTemperatureC: standard.ambientTemperatureC,
    initialSoc: standard.initialSoc,
    eolFraction: standard.endOfLifeFraction,
    createdAt: now,
  };
  const standardStudyRequest = {
    schema_version: "V0.2",
    study_version: `${versionLabel}@${product.revision}`,
    result_version: `result-${runId}`,
    exposure_plan: {
      schema_version: "V0.2",
      standard_scenario_version: versionLabel,
      code_revision: standard.codeRevision,
      product_revision: product.revision,
      study_start_date: studyStartDate,
      horizon_years: standard.horizonYears,
      nominal_capacity_ah: product.nominalCapacityAh,
      cycles_per_operating_day: standard.cyclesPerDay,
      operating_availability_fraction: standard.operatingAvailabilityFraction,
      soc_window_min: standard.socWindowMin,
      soc_window_max: standard.socWindowMax,
      depth_of_discharge: standard.depthOfDischarge,
      cell_temperature_c: standard.cellTemperatureC,
      max_charge_c_rate: standard.maxChargeCRate,
      max_discharge_c_rate: standard.maxDischargeCRate,
      initial_elapsed_days: 0,
      initial_absolute_throughput_ah: 0,
      initial_cycle_count: 0,
      initial_equivalent_full_cycles: 0,
    },
    calibration: parsedCalibration.value,
    calibration_approval_status: "approved",
  };
  const payload = {
    contract_version: "3.0",
    job_id: runId,
    scenario_id: scenarioId,
    user_id: owner,
    engine: "standard-study",
    model_version: calibration.modelVersion,
    code_revision: standard.codeRevision,
    scenario: null,
    standard_study_request: standardStudyRequest,
    submitted_at: now,
  };
  if (
    !standardStudyRequestIsValid(standardStudyRequest) ||
    !standardStudyJobPayloadIsValid(payload, runId)
  ) {
    return Response.json({ error: "Selected records cannot form a valid worker contract" }, { status: 409 });
  }
  const payloadBytes = new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
  const payloadChecksum = await sha256Hex(payloadBytes.buffer as ArrayBuffer);
  const payloadObjectKey = `runs/${runId}/job-payload.json`;
  await env.STUDY_ARTIFACTS.put(payloadObjectKey, payloadBytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { runId, sha256: payloadChecksum },
  });
  const run = {
    id: runId,
    scenarioId,
    userId: owner,
    idempotencyKey: key.value,
    engine: "standard-study",
    modelVersion: calibration.modelVersion,
    codeRevision: standard.codeRevision,
    jobContractVersion: "3.0",
    payloadObjectKey,
    payloadChecksumSha256: payloadChecksum,
    status: "queued",
    progress: 0,
    endSoh: null,
    attempt: 0,
    leaseExpiresAt: null,
    heartbeatAt: null,
    workerId: null,
    checkpointUri: null,
    error: null,
    withinValidityEnvelope: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.batch([db.insert(scenarios).values(scenario), db.insert(runs).values(run)]);
  } catch {
    await env.STUDY_ARTIFACTS.delete(payloadObjectKey);
    return Response.json({ error: "Standard study was submitted concurrently; retry with the same key" }, { status: 409 });
  }
  return Response.json({ simulation: toRunView(run, scenario) }, { status: 201 });
}
