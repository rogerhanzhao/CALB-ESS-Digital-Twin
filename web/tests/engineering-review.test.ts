import assert from "node:assert/strict";
import test from "node:test";

import {
  evidenceAllowsEngineeringApproval,
  parseEngineeringReviewInput,
} from "../lib/engineering-review.ts";

test("review decisions require a substantive comment", () => {
  assert.equal(parseEngineeringReviewInput({ decision: "approved", comment: "证据链完整，可进入工程发布审核。" }).ok, true);
  assert.equal(parseEngineeringReviewInput({ decision: "approved", comment: "同意" }).ok, false);
  assert.equal(parseEngineeringReviewInput({ decision: "pending", comment: "需要进一步确认这个结果。" }).ok, false);
});

const manifest = {
  schema_version: "V0.2",
  result_version: "result-001",
  calibration_id: "calibration-001",
  engineering_review_eligible: true,
  warranty_eligible: false,
};
const sohResult = {
  ...manifest,
  all_points_within_validity_envelope: true,
  all_predictions_physically_valid: true,
  uncertainty_status: "not_quantified",
};

test("engineering approval requires matching, fully valid evidence", () => {
  assert.equal(evidenceAllowsEngineeringApproval(manifest, sohResult), true);
  assert.equal(evidenceAllowsEngineeringApproval(manifest, { ...sohResult, all_points_within_validity_envelope: false }), false);
  assert.equal(evidenceAllowsEngineeringApproval(manifest, { ...sohResult, warranty_eligible: true }), false);
  assert.equal(evidenceAllowsEngineeringApproval(manifest, { ...sohResult, result_version: "other" }), false);
});
