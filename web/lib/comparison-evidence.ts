import Ajv from "ajv";
import addFormats from "ajv-formats";
import manifestSchema from "../../contracts/generated/study-comparison-manifest.schema.json" with { type: "json" };
import requestSchema from "../../contracts/generated/study-comparison-request.schema.json" with { type: "json" };
import resultSchema from "../../contracts/generated/study-comparison-result.schema.json" with { type: "json" };
import { sha256Hex, type ComparisonWorkerCompletion } from "./worker-api.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateManifest = ajv.compile(manifestSchema);
const validateRequest = ajv.compile(requestSchema);
const validateResult = ajv.compile(resultSchema);

type EvidenceBytes = Record<
  "comparison-manifest.json" | "comparison-request.json" | "comparison-result.json",
  ArrayBuffer
>;

export async function verifyComparisonEvidenceBundle(
  contents: EvidenceBytes,
  completion: ComparisonWorkerCompletion,
  expected: { comparisonVersion: string; codeRevision: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const decoded = new Map<string, unknown>();
  for (const [kind, content] of Object.entries(contents)) {
    const artifact = completion.artifacts.find((item) => item.kind === kind);
    if (!artifact || artifact.sizeBytes !== content.byteLength ||
        artifact.checksumSha256 !== await sha256Hex(content)) {
      return { ok: false, reason: `${kind} bytes do not match completion metadata` };
    }
    try {
      decoded.set(kind, JSON.parse(new TextDecoder().decode(content)));
    } catch {
      return { ok: false, reason: `${kind} is not valid JSON` };
    }
  }
  const manifest = decoded.get("comparison-manifest.json");
  const request = decoded.get("comparison-request.json");
  const result = decoded.get("comparison-result.json");
  if (!validateManifest(manifest) || !isRecord(manifest)) {
    return { ok: false, reason: "comparison manifest contract is invalid" };
  }
  if (!validateRequest(request) || !isRecord(request)) {
    return { ok: false, reason: "comparison request contract is invalid" };
  }
  if (!validateResult(result) || !isRecord(result)) {
    return { ok: false, reason: "comparison result contract is invalid" };
  }

  const files = manifest.files;
  if (!Array.isArray(files) || files.length !== 2) {
    return { ok: false, reason: "comparison manifest must bind exactly request and result" };
  }
  for (const kind of ["comparison-request.json", "comparison-result.json"] as const) {
    const record = files.find((item) => isRecord(item) && item.file_name === kind);
    const artifact = completion.artifacts.find((item) => item.kind === kind);
    if (!isRecord(record) || !artifact) {
      return { ok: false, reason: `comparison manifest is missing ${kind}` };
    }
    const checksum = await sha256Hex(contents[kind]);
    if (
      record.sha256 !== checksum ||
      record.byte_count !== contents[kind].byteLength ||
      artifact.checksumSha256 !== checksum ||
      artifact.sizeBytes !== contents[kind].byteLength
    ) {
      return { ok: false, reason: `comparison manifest metadata differs for ${kind}` };
    }
  }
  if (
    manifest.comparison_version !== result.comparison_version ||
    manifest.comparison_version !== request.comparison_version ||
    manifest.baseline_result_version !== result.baseline_result_version ||
    manifest.current_result_version !== result.current_result_version
  ) {
    return { ok: false, reason: "comparison identities differ across request, result, and manifest" };
  }
  const baselineManifest = nestedManifest(request.baseline);
  const currentManifest = nestedManifest(request.current);
  if (!baselineManifest || !currentManifest ||
      baselineManifest.result_version !== result.baseline_result_version ||
      currentManifest.result_version !== result.current_result_version) {
    return { ok: false, reason: "comparison result versions do not match source evidence manifests" };
  }
  const baselineExposure = nestedExposure(request.baseline);
  const currentExposure = nestedExposure(request.current);
  if (!baselineExposure || !currentExposure ||
      baselineExposure.product_revision !== currentExposure.product_revision ||
      baselineExposure.standard_scenario_version !== currentExposure.standard_scenario_version ||
      stableJson(baselineExposure.conditions) !== stableJson(currentExposure.conditions) ||
      result.product_revision !== baselineExposure.product_revision ||
      result.standard_scenario_version !== baselineManifest.standard_scenario_version ||
      result.baseline_study_version !== baselineManifest.study_version ||
      result.current_study_version !== currentManifest.study_version ||
      result.baseline_calibration_id !== baselineManifest.calibration_id ||
      result.current_calibration_id !== currentManifest.calibration_id ||
      !sameStrings(result.baseline_dataset_revision_ids, stringArray(baselineManifest.calibration_dataset_revision_ids)) ||
      !sameStrings(result.current_dataset_revision_ids, stringArray(currentManifest.calibration_dataset_revision_ids)) ||
      result.scenario_code_revision_changed !== (baselineManifest.scenario_code_revision !== currentManifest.scenario_code_revision) ||
      result.engineering_review_eligibility_changed !== (baselineManifest.engineering_review_eligible !== currentManifest.engineering_review_eligible) ||
      result.calibration_evidence_changed !== calibrationEvidenceChanged(baselineManifest, currentManifest)) {
    return { ok: false, reason: "comparison provenance does not match source study evidence" };
  }
  const derived = deriveComparisonSummary(request);
  if (!derived.ok) return derived;
  const summary = completion.result;
  if (
    !near(result.final_capacity_delta_fraction, derived.finalDelta) ||
    !near(result.maximum_absolute_capacity_delta_fraction, derived.maximumDelta) ||
    !near(summary.final_capacity_delta_fraction, derived.finalDelta) ||
    !near(summary.maximum_absolute_capacity_delta_fraction, derived.maximumDelta) ||
    summary.comparison_version !== result.comparison_version ||
    summary.comparison_version !== expected.comparisonVersion ||
    summary.code_revision !== expected.codeRevision
  ) {
    return { ok: false, reason: "completion summary does not match recomputed evidence deltas" };
  }
  const validityChangedYears = derived.years.filter((_, index) => ["became_valid", "became_invalid"].includes(derived.validityTransitions[index]));
  const physicalChangedYears = derived.years.filter((_, index) => ["became_valid", "became_invalid"].includes(derived.physicalTransitions[index]));
  if (!sameValues(result.validity_changed_years, validityChangedYears) ||
      !sameValues(result.physical_validity_changed_years, physicalChangedYears)) {
    return { ok: false, reason: "comparison trust-state summary does not match source studies" };
  }
  if (
    result.improved_point_count !== derived.improved ||
    result.degraded_point_count !== derived.degraded ||
    result.unchanged_point_count !== derived.unchanged ||
    !Array.isArray(result.points) || result.points.length !== derived.deltas.length
  ) {
    return { ok: false, reason: "comparison point classifications do not match source studies" };
  }
  for (let index = 0; index < derived.deltas.length; index += 1) {
    const point = result.points[index];
    if (!isRecord(point) || !near(point.capacity_delta_fraction, derived.deltas[index]) ||
        !near(point.baseline_capacity_fraction, derived.baselineCapacities[index]) ||
        !near(point.current_capacity_fraction, derived.currentCapacities[index]) ||
        point.capacity_direction !== derived.directions[index] || point.year !== derived.years[index] ||
        point.calendar_date !== derived.dates[index] ||
        point.validity_transition !== derived.validityTransitions[index] ||
        point.physical_transition !== derived.physicalTransitions[index] ||
        !sameStrings(point.added_issues, derived.addedIssues[index]) ||
        !sameStrings(point.removed_issues, derived.removedIssues[index])) {
      return { ok: false, reason: "comparison result points do not match source study trajectories" };
    }
  }
  return { ok: true };
}

function deriveComparisonSummary(request: Record<string, unknown>):
  | { ok: true; finalDelta: number; maximumDelta: number; improved: number; degraded: number; unchanged: number; deltas: number[]; directions: string[]; years: unknown[]; dates: unknown[]; baselineCapacities: number[]; currentCapacities: number[]; validityTransitions: string[]; physicalTransitions: string[]; addedIssues: string[][]; removedIssues: string[][] }
  | { ok: false; reason: string } {
  const baseline = nestedPoints(request.baseline);
  const current = nestedPoints(request.current);
  const policy = isRecord(request.policy) ? request.policy : null;
  const tolerance = policy?.capacity_delta_tolerance_fraction;
  if (!baseline || !current || baseline.length === 0 || baseline.length !== current.length || typeof tolerance !== "number") {
    return { ok: false, reason: "comparison request trajectories cannot be recomputed" };
  }
  const deltas: number[] = [];
  const directions: string[] = [];
  const years: unknown[] = [];
  const dates: unknown[] = [];
  const baselineCapacities: number[] = [];
  const currentCapacities: number[] = [];
  const validityTransitions: string[] = [];
  const physicalTransitions: string[] = [];
  const addedIssues: string[][] = [];
  const removedIssues: string[][] = [];
  let improved = 0;
  let degraded = 0;
  let unchanged = 0;
  for (let index = 0; index < baseline.length; index += 1) {
    const oldPoint = baseline[index];
    const newPoint = current[index];
    if (!isRecord(oldPoint) || !isRecord(newPoint) || oldPoint.year !== newPoint.year || oldPoint.calendar_date !== newPoint.calendar_date ||
        typeof oldPoint.predicted_capacity_fraction !== "number" || typeof newPoint.predicted_capacity_fraction !== "number") {
      return { ok: false, reason: "comparison request trajectory axes are not like-for-like" };
    }
    for (const [field, toleranceField] of [
      ["elapsed_days", "elapsed_days_tolerance"],
      ["absolute_throughput_ah", "absolute_throughput_ah_tolerance"],
      ["cycle_count", "cycle_count_tolerance"],
      ["equivalent_full_cycles", "equivalent_full_cycles_tolerance"],
    ] as const) {
      const oldValue = oldPoint[field];
      const newValue = newPoint[field];
      const axisTolerance = policy?.[toleranceField];
      if (typeof oldValue !== "number" || typeof newValue !== "number" ||
          typeof axisTolerance !== "number" || Math.abs(oldValue - newValue) > axisTolerance) {
        return { ok: false, reason: `comparison request ${field} axis is not like-for-like` };
      }
    }
    const delta = newPoint.predicted_capacity_fraction - oldPoint.predicted_capacity_fraction;
    deltas.push(delta);
    years.push(oldPoint.year);
    dates.push(oldPoint.calendar_date);
    baselineCapacities.push(oldPoint.predicted_capacity_fraction);
    currentCapacities.push(newPoint.predicted_capacity_fraction);
    validityTransitions.push(transition(oldPoint.within_validity_envelope, newPoint.within_validity_envelope));
    physicalTransitions.push(transition(oldPoint.physically_valid_prediction, newPoint.physically_valid_prediction));
    const oldIssues = stringSet(oldPoint.issues);
    const newIssues = stringSet(newPoint.issues);
    addedIssues.push([...newIssues].filter((item) => !oldIssues.has(item)).sort());
    removedIssues.push([...oldIssues].filter((item) => !newIssues.has(item)).sort());
    if (delta > tolerance) { improved += 1; directions.push("improved"); }
    else if (delta < -tolerance) { degraded += 1; directions.push("degraded"); }
    else { unchanged += 1; directions.push("unchanged"); }
  }
  return {
    ok: true,
    finalDelta: deltas.at(-1)!,
    maximumDelta: Math.max(...deltas.map(Math.abs)),
    improved,
    degraded,
    unchanged,
    deltas,
    directions,
    years,
    dates,
    baselineCapacities,
    currentCapacities,
    validityTransitions,
    physicalTransitions,
    addedIssues,
    removedIssues,
  };
}

function nestedPoints(value: unknown): unknown[] | null {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.artifact.soh_result)) return null;
  return Array.isArray(value.artifact.soh_result.points) ? value.artifact.soh_result.points : null;
}

function nestedManifest(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.manifest) ? value.manifest : null;
}

function nestedExposure(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.artifact) && isRecord(value.artifact.exposure)
    ? value.artifact.exposure : null;
}

function near(value: unknown, expected: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value - expected) <= 1e-12;
}

function transition(oldValue: unknown, newValue: unknown): string {
  if (oldValue === true && newValue === false) return "became_invalid";
  if (oldValue === false && newValue === true) return "became_valid";
  return newValue === true ? "stayed_valid" : "stayed_invalid";
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function sameStrings(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sameValues(value: unknown, expected: unknown[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function calibrationEvidenceChanged(oldManifest: Record<string, unknown>, newManifest: Record<string, unknown>): boolean {
  return oldManifest.calibration_id !== newManifest.calibration_id ||
    oldManifest.calibration_model_version !== newManifest.calibration_model_version ||
    oldManifest.calibration_code_revision !== newManifest.calibration_code_revision ||
    !sameValues(oldManifest.calibration_dataset_revision_ids, Array.isArray(newManifest.calibration_dataset_revision_ids) ? newManifest.calibration_dataset_revision_ids : []);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
