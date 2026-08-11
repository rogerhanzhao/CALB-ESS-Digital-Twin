export type DatasetColumnMapping = {
  source_column: string;
  canonical_column: string;
  source_unit: string;
};

const BASE_COLUMNS = [
  ["timestamp", "iso8601"],
  ["elapsed_time_s", "s"],
  ["voltage_v", "V"],
  ["current_a", "A"],
  ["cell_temperature_c", "degC"],
  ["ambient_temperature_c", "degC"],
] as const;

const TYPE_COLUMNS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  cycle_aging: [
    ["capacity_ah", "Ah"],
    ["cycle_index", "integer"],
    ["step_index", "integer"],
  ],
  calendar_aging: [["capacity_ah", "Ah"]],
  hppc: [
    ["soc_fraction", "fraction"],
    ["step_index", "integer"],
    ["rest_duration_s", "s"],
  ],
  temperature: [],
};

const UNIT_OPTIONS: Record<string, readonly string[]> = {
  iso8601: ["iso8601"],
  s: ["s", "ms", "min", "h"],
  V: ["V", "mV"],
  A: ["A", "mA"],
  degC: ["degC", "K"],
  Ah: ["Ah", "mAh"],
  fraction: ["fraction", "percent"],
  integer: ["integer"],
};

export function mappingTemplate(
  testType: string,
  sourceColumns: string[] | null,
): DatasetColumnMapping[] {
  const byNormalizedName = new Map(
    (sourceColumns ?? []).map((column) => [
      column.trim().toLowerCase(),
      column,
    ]),
  );
  return [...BASE_COLUMNS, ...(TYPE_COLUMNS[testType] ?? [])].map(
    ([canonical, unit]) => ({
      source_column:
        sourceColumns === null
          ? canonical
          : (byNormalizedName.get(canonical.toLowerCase()) ?? ""),
      canonical_column: canonical,
      source_unit: unit,
    }),
  );
}

export function unitOptionsFor(
  mapping: DatasetColumnMapping,
): readonly string[] {
  return (
    UNIT_OPTIONS[expectedCanonicalUnit(mapping.canonical_column)] ?? [
      mapping.source_unit,
    ]
  );
}

export function missingCanonicalColumns(
  mappings: DatasetColumnMapping[],
): string[] {
  return mappings
    .filter((mapping) => !mapping.source_column.trim())
    .map((mapping) => mapping.canonical_column);
}

export function duplicateSourceColumns(
  mappings: DatasetColumnMapping[],
): string[] {
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    const source = mapping.source_column.trim();
    if (source) counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([source]) => source);
}

export function parseMappingJson(value: string): DatasetColumnMapping[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    if (
      !parsed.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).source_column === "string" &&
          typeof (item as Record<string, unknown>).canonical_column ===
            "string" &&
          typeof (item as Record<string, unknown>).source_unit === "string",
      )
    )
      return null;
    return parsed as DatasetColumnMapping[];
  } catch {
    return null;
  }
}

function expectedCanonicalUnit(canonicalColumn: string): string {
  return (
    [...BASE_COLUMNS, ...Object.values(TYPE_COLUMNS).flat()].find(
      ([column]) => column === canonicalColumn,
    )?.[1] ?? ""
  );
}
