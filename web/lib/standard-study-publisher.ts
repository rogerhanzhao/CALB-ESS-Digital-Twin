export type StandardStudySubmission = {
  standardScenarioId: string;
  calibrationId: string;
  studyStartDate: string;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateStandardStudyRequest = ajv.compile(standardStudyRequestSchema);

export function standardStudyRequestIsValid(value: unknown): boolean {
  return validateStandardStudyRequest(value);
}

export function parseStandardStudySubmission(value: unknown): Parsed<StandardStudySubmission> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const standardScenarioId = textId(value.standardScenarioId);
  const calibrationId = textId(value.calibrationId);
  const studyStartDate = typeof value.studyStartDate === "string" ? value.studyStartDate : "";
  const errors: string[] = [];
  if (!standardScenarioId) errors.push("standardScenarioId is required and must be at most 80 characters");
  if (!calibrationId) errors.push("calibrationId is required and must be at most 80 characters");
  if (!validDate(studyStartDate)) errors.push("studyStartDate must be a real ISO calendar date");
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { standardScenarioId, calibrationId, studyStartDate } };
}

function textId(value: unknown): string {
  if (typeof value !== "string") return "";
  const result = value.trim();
  return result && result.length <= 80 ? result : "";
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import standardStudyRequestSchema from "../../contracts/generated/standard-study-request.schema.json" with { type: "json" };
import Ajv from "ajv";
import addFormats from "ajv-formats";
