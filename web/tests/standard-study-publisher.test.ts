import assert from "node:assert/strict";
import test from "node:test";

import { parseStandardStudySubmission } from "../lib/standard-study-publisher.ts";

const valid = {
  standardScenarioId: "scenario-001",
  calibrationId: "calibration-001",
  studyStartDate: "2026-01-01",
};

test("accepts an explicit standard-study selection and start date", () => {
  assert.equal(parseStandardStudySubmission(valid).ok, true);
});

test("requires both immutable record identities", () => {
  for (const field of ["standardScenarioId", "calibrationId"]) {
    const parsed = parseStandardStudySubmission({ ...valid, [field]: "" });
    assert.equal(parsed.ok, false);
  }
});

test("rejects normalized-looking dates that are not real calendar dates", () => {
  for (const studyStartDate of ["2026-02-29", "2026-13-01", "2026-1-1", "today"] ) {
    assert.equal(parseStandardStudySubmission({ ...valid, studyStartDate }).ok, false);
  }
  assert.equal(
    parseStandardStudySubmission({ ...valid, studyStartDate: "2028-02-29" }).ok,
    true,
  );
});
