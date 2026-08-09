export const TEST_TYPES = ["cycle_aging", "calendar_aging", "hppc", "temperature"] as const;
export type TestType = (typeof TEST_TYPES)[number];

type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type ProductInput = {
  manufacturer: string;
  model: string;
  chemistry: "LFP";
  nominalCapacityAh: number;
  nominalVoltageV: number;
  revision: string;
};

export type DatasetInput = {
  productId: string;
  sampleCode: string;
  name: string;
  testType: TestType;
  batchCode: string;
  sourceLab: string;
  equipmentId: string;
  operator: string;
  testStartedAt: string;
  testEndedAt: string;
  fileName: string;
  checksumSha256: string | null;
  rowCount: number | null;
  unitSchema: string;
};

function objectBody(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function requiredText(body: Record<string, unknown>, key: string, errors: string[], max = 160) {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${key} is required`);
    return "";
  }
  if (value.trim().length > max) errors.push(`${key} must be at most ${max} characters`);
  return value.trim();
}

export function parseProductInput(payload: unknown): Validation<ProductInput> {
  const body = objectBody(payload);
  if (!body) return { ok: false, errors: ["request body must be a JSON object"] };
  const errors: string[] = [];
  const manufacturer = requiredText(body, "manufacturer", errors, 80);
  const model = requiredText(body, "model", errors, 120);
  const revision = requiredText(body, "revision", errors, 40);
  if (body.chemistry !== "LFP") errors.push("chemistry must be LFP in V0.2");
  const capacity = body.nominalCapacityAh;
  const voltage = body.nominalVoltageV;
  if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0 || capacity > 2000) errors.push("nominalCapacityAh must be between 0 and 2000");
  if (typeof voltage !== "number" || !Number.isFinite(voltage) || voltage <= 0 || voltage > 10) errors.push("nominalVoltageV must be between 0 and 10");
  return errors.length ? { ok: false, errors } : { ok: true, value: { manufacturer, model, revision, chemistry: "LFP", nominalCapacityAh: capacity as number, nominalVoltageV: voltage as number } };
}

export function parseDatasetInput(payload: unknown): Validation<DatasetInput> {
  const body = objectBody(payload);
  if (!body) return { ok: false, errors: ["request body must be a JSON object"] };
  const errors: string[] = [];
  const productId = requiredText(body, "productId", errors, 80);
  const sampleCode = requiredText(body, "sampleCode", errors, 80);
  const name = requiredText(body, "name", errors, 120);
  const batchCode = requiredText(body, "batchCode", errors, 80);
  const sourceLab = requiredText(body, "sourceLab", errors, 120);
  const equipmentId = requiredText(body, "equipmentId", errors, 120);
  const operator = requiredText(body, "operator", errors, 120);
  const testStartedAt = requiredText(body, "testStartedAt", errors, 50);
  const testEndedAt = requiredText(body, "testEndedAt", errors, 50);
  const started = Date.parse(testStartedAt);
  const ended = Date.parse(testEndedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) errors.push("test period must contain valid ISO timestamps with end after start");
  const fileName = requiredText(body, "fileName", errors, 240);
  const unitSchema = requiredText(body, "unitSchema", errors, 2000);
  const testType = body.testType;
  if (!TEST_TYPES.includes(testType as TestType)) errors.push(`testType must be one of: ${TEST_TYPES.join(", ")}`);
  const checksum = body.checksumSha256;
  if (checksum !== null && checksum !== undefined && (typeof checksum !== "string" || !/^[a-f0-9]{64}$/i.test(checksum))) errors.push("checksumSha256 must be a 64-character SHA-256 hex digest");
  const rows = body.rowCount;
  if (rows !== null && rows !== undefined && (!Number.isInteger(rows) || (rows as number) < 0)) errors.push("rowCount must be a non-negative integer");
  return errors.length ? { ok: false, errors } : { ok: true, value: { productId, sampleCode, name, batchCode, sourceLab, equipmentId, operator, testStartedAt, testEndedAt, fileName, unitSchema, testType: testType as TestType, checksumSha256: typeof checksum === "string" ? checksum.toLowerCase() : null, rowCount: typeof rows === "number" ? rows : null } };
}
