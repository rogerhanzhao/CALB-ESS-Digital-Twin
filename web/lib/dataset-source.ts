export const MAX_SOURCE_DATASET_BYTES = 25 * 1024 * 1024;

export type DatasetSourceValidation =
  | {
      ok: true;
      contentType: string;
      rowCount: number | null;
      sourceColumns: string[] | null;
    }
  | { ok: false; error: string };

export function validateDatasetSource(
  fileName: string,
  bytes: Uint8Array,
): DatasetSourceValidation {
  const lower = fileName.toLowerCase();
  if (bytes.byteLength === 0)
    return { ok: false, error: "source file must not be empty" };
  if (bytes.byteLength > MAX_SOURCE_DATASET_BYTES) {
    return { ok: false, error: "source file exceeds the 25 MiB V0.2 limit" };
  }
  if (lower.endsWith(".csv")) return validateCsv(bytes);
  if (lower.endsWith(".xlsx")) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return {
        ok: false,
        error: "XLSX source does not have a valid ZIP container signature",
      };
    }
    return {
      ok: true,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      rowCount: null,
      sourceColumns: null,
    };
  }
  return { ok: false, error: "V0.2 source files must use .csv or .xlsx" };
}

function validateCsv(bytes: Uint8Array): DatasetSourceValidation {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "CSV source must be valid UTF-8" };
  }
  if (text.includes("\0"))
    return { ok: false, error: "CSV source contains NUL bytes" };
  const rows = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0);
  if (rows.length < 2)
    return {
      ok: false,
      error: "CSV source must contain a header and at least one data row",
    };
  const header = rows[0].replace(/^\uFEFF/, "");
  if (!header.includes(","))
    return { ok: false, error: "CSV source must use a comma-delimited header" };
  const sourceColumns = parseCsvHeader(header);
  if (!sourceColumns.ok) return sourceColumns;
  return {
    ok: true,
    contentType: "text/csv; charset=utf-8",
    rowCount: rows.length - 1,
    sourceColumns: sourceColumns.columns,
  };
}

function parseCsvHeader(
  header: string,
): { ok: true; columns: string[] } | { ok: false; error: string } {
  const columns: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"') {
      if (quoted && header[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      columns.push(value.trim());
      value = "";
    } else value += character;
  }
  if (quoted)
    return {
      ok: false,
      error: "CSV header contains an unterminated quoted column",
    };
  columns.push(value.trim());
  if (columns.length > 200)
    return { ok: false, error: "CSV header exceeds the 200-column limit" };
  if (columns.some((column) => !column))
    return { ok: false, error: "CSV header contains an empty column name" };
  if (new Set(columns).size !== columns.length)
    return { ok: false, error: "CSV header column names must be unique" };
  if (columns.some((column) => column.length > 200))
    return {
      ok: false,
      error: "CSV header column names must not exceed 200 characters",
    };
  return { ok: true, columns };
}
