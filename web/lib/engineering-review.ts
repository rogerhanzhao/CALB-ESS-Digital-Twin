export const ENGINEERING_REVIEW_DECISIONS = [
  "approved",
  "changes_requested",
  "rejected",
] as const;

export type EngineeringReviewDecision = (typeof ENGINEERING_REVIEW_DECISIONS)[number];
export type EngineeringReviewInput = { decision: EngineeringReviewDecision; comment: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseEngineeringReviewInput(value: unknown): Parsed<EngineeringReviewInput> {
  if (!isRecord(value)) return { ok: false, errors: ["request body must be a JSON object"] };
  const errors: string[] = [];
  const decision = value.decision;
  if (!ENGINEERING_REVIEW_DECISIONS.includes(decision as EngineeringReviewDecision)) {
    errors.push(`decision must be one of: ${ENGINEERING_REVIEW_DECISIONS.join(", ")}`);
  }
  const comment = typeof value.comment === "string" ? value.comment.trim() : "";
  if (comment.length < 10 || comment.length > 2000) {
    errors.push("comment must contain 10-2000 characters");
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { decision: decision as EngineeringReviewDecision, comment } };
}

export function evidenceAllowsEngineeringApproval(manifest: unknown, sohResult: unknown): boolean {
  if (!isRecord(manifest) || !isRecord(sohResult)) return false;
  return (
    manifest.schema_version === "V0.2" &&
    sohResult.schema_version === "V0.2" &&
    manifest.result_version === sohResult.result_version &&
    manifest.calibration_id === sohResult.calibration_id &&
    manifest.engineering_review_eligible === true &&
    sohResult.engineering_review_eligible === true &&
    manifest.warranty_eligible === false &&
    sohResult.warranty_eligible === false &&
    sohResult.all_points_within_validity_envelope === true &&
    sohResult.all_predictions_physically_valid === true &&
    sohResult.uncertainty_status === "not_quantified"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
