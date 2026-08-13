"""Deterministic intake validation for measured cell-test CSV data.

The validator deliberately knows no CALB product limits.  Approved product and
test-plan bounds are injected for each import, so generic code cannot silently
invent or broaden a calibration envelope.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Literal

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "V0.2"


class TestType(StrEnum):
    CYCLE_AGING = "cycle_aging"
    CALENDAR_AGING = "calendar_aging"
    HPPC = "hppc"
    TEMPERATURE = "temperature"


class CurrentSign(StrEnum):
    CHARGE_POSITIVE = "charge_positive"
    DISCHARGE_POSITIVE = "discharge_positive"


class ValidationLevel(StrEnum):
    PASS = "pass"
    WARNING = "warning"
    REJECT = "reject"


class ImportManifest(BaseModel):
    """Immutable source identity and physical-test provenance."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = SCHEMA_VERSION
    product_id: str = Field(min_length=1)
    sample_id: str = Field(min_length=1)
    batch_code: str = Field(min_length=1)
    test_type: TestType
    source_lab: str = Field(min_length=1)
    equipment_id: str = Field(min_length=1)
    test_started_at: datetime
    test_ended_at: datetime
    file_name: str = Field(min_length=1)
    file_sha256: str
    operator: str = Field(min_length=1)
    notes: str | None = None
    current_sign: CurrentSign = CurrentSign.CHARGE_POSITIVE

    @field_validator("file_sha256")
    @classmethod
    def sha256_is_hex(cls, value: str) -> str:
        normalized = value.lower()
        if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
            raise ValueError("file_sha256 must contain 64 hexadecimal characters")
        return normalized

    @field_validator("test_started_at", "test_ended_at")
    @classmethod
    def timestamp_has_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("test timestamps must include a timezone")
        return value

    @model_validator(mode="after")
    def test_period_is_forward(self) -> ImportManifest:
        if self.test_ended_at <= self.test_started_at:
            raise ValueError("test_ended_at must be later than test_started_at")
        return self


class ColumnMapping(BaseModel):
    """Versioned, explicit mapping from source data to a canonical quantity."""

    model_config = ConfigDict(extra="forbid")

    source_column: str = Field(min_length=1)
    canonical_column: str = Field(min_length=1)
    source_unit: str = Field(min_length=1)


class ValidationPolicy(BaseModel):
    """Approved product/test-plan bounds supplied by the caller."""

    model_config = ConfigDict(extra="forbid")

    voltage_min_v: float
    voltage_max_v: float
    absolute_current_max_a: float = Field(gt=0)
    temperature_min_c: float
    temperature_max_c: float
    irregular_interval_fraction: float = Field(default=0.10, ge=0)
    gap_interval_multiplier: float = Field(default=3.0, gt=1)

    @model_validator(mode="after")
    def bounds_are_ordered(self) -> ValidationPolicy:
        if self.voltage_max_v <= self.voltage_min_v:
            raise ValueError("voltage_max_v must be greater than voltage_min_v")
        if self.temperature_max_c <= self.temperature_min_c:
            raise ValueError("temperature_max_c must be greater than temperature_min_c")
        return self


class ValidationIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: Literal[ValidationLevel.WARNING, ValidationLevel.REJECT]
    code: str
    message: str
    row: int | None = None
    column: str | None = None


class ValidationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = SCHEMA_VERSION
    source_sha256: str
    source_row_count: int
    normalized_row_count: int
    outcome: ValidationLevel
    issues: list[ValidationIssue]
    applied_conversions: list[str]


@dataclass(frozen=True)
class ValidatedImport:
    report: ValidationReport
    normalized: pd.DataFrame | None


_CANONICAL_UNITS = {
    "timestamp": "iso8601",
    "elapsed_time_s": "s",
    "voltage_v": "V",
    "current_a": "A",
    "cell_temperature_c": "degC",
    "ambient_temperature_c": "degC",
    "capacity_ah": "Ah",
    "energy_wh": "Wh",
    "soc_fraction": "fraction",
    "cycle_index": "integer",
    "step_index": "integer",
    "rest_duration_s": "s",
}

_CONVERSIONS: dict[tuple[str, str], tuple[float, float]] = {
    (unit, unit): (1.0, 0.0) for unit in set(_CANONICAL_UNITS.values())
}
_CONVERSIONS.update(
    {
        ("mV", "V"): (0.001, 0.0),
        ("mA", "A"): (0.001, 0.0),
        ("K", "degC"): (1.0, -273.15),
        ("mAh", "Ah"): (0.001, 0.0),
        ("kWh", "Wh"): (1000.0, 0.0),
        ("percent", "fraction"): (0.01, 0.0),
        ("ms", "s"): (0.001, 0.0),
        ("min", "s"): (60.0, 0.0),
        ("h", "s"): (3600.0, 0.0),
    }
)

_BASE_REQUIRED = {
    "timestamp",
    "elapsed_time_s",
    "voltage_v",
    "current_a",
    "cell_temperature_c",
    "ambient_temperature_c",
}
_TYPE_REQUIRED = {
    TestType.CYCLE_AGING: {"capacity_ah", "cycle_index", "step_index"},
    TestType.CALENDAR_AGING: {"capacity_ah"},
    TestType.HPPC: {"soc_fraction", "step_index", "rest_duration_s"},
    TestType.TEMPERATURE: set(),
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_csv_import(
    source_path: Path,
    manifest: ImportManifest,
    mappings: list[ColumnMapping],
    policy: ValidationPolicy,
) -> ValidatedImport:
    """Validate and normalize a CSV without modifying the source artifact."""

    issues: list[ValidationIssue] = []
    conversions: list[str] = []
    try:
        actual_sha = file_sha256(source_path)
    except OSError as exc:
        report = _report(
            "",
            0,
            0,
            [_reject("source_unreadable", f"Source file cannot be read: {exc}")],
            [],
        )
        return ValidatedImport(report=report, normalized=None)
    if source_path.name != manifest.file_name:
        issues.append(_reject("file_name_mismatch", "Source file name does not match manifest"))
    if actual_sha != manifest.file_sha256:
        issues.append(_reject("checksum_mismatch", "Source SHA-256 does not match manifest"))

    try:
        source = pd.read_csv(source_path, encoding="utf-8")
    except (OSError, UnicodeError, pd.errors.ParserError) as exc:
        report = _report(actual_sha, 0, 0, issues + [_reject("csv_parse_error", str(exc))], [])
        return ValidatedImport(report=report, normalized=None)

    if source.empty:
        report = _report(
            actual_sha,
            0,
            0,
            issues + [_reject("empty_dataset", "Source dataset contains no measurement rows")],
            [],
        )
        return ValidatedImport(report=report, normalized=None)

    normalized = pd.DataFrame(index=source.index)
    canonical_seen: set[str] = set()
    for mapping in mappings:
        canonical = mapping.canonical_column
        if canonical in canonical_seen:
            issues.append(_reject("duplicate_mapping", f"Multiple mappings target {canonical}"))
            continue
        canonical_seen.add(canonical)
        target_unit = _CANONICAL_UNITS.get(canonical)
        if target_unit is None:
            issues.append(_reject("unknown_canonical_column", f"Unknown column {canonical}"))
            continue
        if mapping.source_column not in source.columns:
            issues.append(
                _reject("missing_source_column", f"Missing source column {mapping.source_column}")
            )
            continue
        conversion = _CONVERSIONS.get((mapping.source_unit, target_unit))
        if conversion is None:
            issues.append(
                _reject(
                    "incompatible_unit",
                    f"Cannot convert {mapping.source_unit} to {target_unit} for {canonical}",
                    column=canonical,
                )
            )
            continue
        if canonical == "timestamp":
            normalized[canonical] = source[mapping.source_column]
        else:
            numeric = pd.to_numeric(source[mapping.source_column], errors="coerce")
            invalid = numeric.isna() & source[mapping.source_column].notna()
            for row in source.index[invalid].tolist()[:20]:
                issues.append(
                    _reject("non_numeric_value", "Value is not numeric", int(row), canonical)
                )
            scale, offset = conversion
            normalized[canonical] = numeric * scale + offset
        if mapping.source_unit != target_unit:
            conversions.append(f"{canonical}: {mapping.source_unit} -> {target_unit}")

    required = _BASE_REQUIRED | _TYPE_REQUIRED[manifest.test_type]
    for missing in sorted(required - set(normalized.columns)):
        issues.append(_reject("missing_required_column", f"Missing required column {missing}"))

    if any(issue.level == ValidationLevel.REJECT for issue in issues):
        return ValidatedImport(
            report=_report(actual_sha, len(source), len(normalized), issues, conversions),
            normalized=None,
        )

    if manifest.current_sign == CurrentSign.DISCHARGE_POSITIVE:
        normalized["current_a"] = -normalized["current_a"]
        conversions.append("current_a: discharge_positive -> charge_positive")

    issues.extend(_validate_rows(normalized, manifest, policy, required))
    report = _report(actual_sha, len(source), len(normalized), issues, conversions)
    return ValidatedImport(
        report=report,
        normalized=None if report.outcome == ValidationLevel.REJECT else normalized,
    )


def _validate_rows(
    frame: pd.DataFrame,
    manifest: ImportManifest,
    policy: ValidationPolicy,
    required: set[str],
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    timestamps = pd.to_datetime(frame["timestamp"], errors="coerce", format="ISO8601", utc=True)
    invalid_timestamps = timestamps.isna()
    for row, value in frame["timestamp"].items():
        try:
            parsed = datetime.fromisoformat(str(value))
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                invalid_timestamps.loc[row] = True
        except ValueError:
            invalid_timestamps.loc[row] = True
    for row in frame.index[invalid_timestamps].tolist()[:20]:
        issues.append(
            _reject(
                "invalid_timestamp",
                "Timestamp must be ISO 8601 and include a timezone",
                int(row),
                "timestamp",
            )
        )
    if invalid_timestamps.any():
        return issues
    if timestamps.duplicated().any():
        issues.append(_reject("duplicate_timestamp", "Timestamp is duplicated"))
    timestamp_delta = timestamps.diff().dt.total_seconds()
    if (timestamp_delta.iloc[1:] <= 0).any():
        issues.append(_reject("non_monotonic_timestamp", "Timestamp does not strictly increase"))

    elapsed = frame["elapsed_time_s"]
    if elapsed.isna().any() or (elapsed.diff().iloc[1:] <= 0).any():
        issues.append(_reject("invalid_elapsed_time", "Elapsed time must strictly increase"))

    for column in sorted(required - {"timestamp"}):
        for row in frame.index[frame[column].isna()].tolist()[:20]:
            issues.append(
                _reject("missing_required_value", "Required value is missing", int(row), column)
            )

    _range_issues(frame, "voltage_v", policy.voltage_min_v, policy.voltage_max_v, issues)
    _range_issues(
        frame,
        "current_a",
        -policy.absolute_current_max_a,
        policy.absolute_current_max_a,
        issues,
    )
    for column in ("cell_temperature_c", "ambient_temperature_c"):
        _range_issues(frame, column, policy.temperature_min_c, policy.temperature_max_c, issues)
    if "soc_fraction" in frame:
        _range_issues(frame, "soc_fraction", 0.0, 1.0, issues)
    for column in ("cycle_index", "step_index"):
        if column in frame:
            non_integer = frame[column].notna() & (frame[column] % 1 != 0)
            for row in frame.index[non_integer].tolist()[:20]:
                issues.append(_reject("non_integer_index", f"{column} must be integer", int(row), column))
            if (frame[column].diff().dropna() < 0).any():
                issues.append(
                    _reject("decreasing_index", f"{column} decreases unexpectedly", column=column)
                )

    positive_delta = timestamp_delta.iloc[1:]
    if not positive_delta.empty and (positive_delta > 0).all():
        median = positive_delta.median()
        relative = (positive_delta - median).abs() / median if median > 0 else positive_delta
        if (relative > policy.irregular_interval_fraction).any():
            issues.append(_warning("irregular_sampling", "Sampling interval is irregular"))
        if (positive_delta > median * policy.gap_interval_multiplier).any():
            issues.append(_warning("sampling_gap", "Sampling gap exceeds the declared tolerance"))

    if timestamps.iloc[0].to_pydatetime() < manifest.test_started_at.astimezone(
        timestamps.iloc[0].tz
    ) or timestamps.iloc[-1].to_pydatetime() > manifest.test_ended_at.astimezone(
        timestamps.iloc[-1].tz
    ):
        issues.append(_reject("timestamp_outside_test_period", "Measurements exceed test period"))
    return issues


def _range_issues(
    frame: pd.DataFrame,
    column: str,
    lower: float,
    upper: float,
    issues: list[ValidationIssue],
) -> None:
    invalid = frame[column].isna() | ~frame[column].between(lower, upper, inclusive="both")
    for row in frame.index[invalid].tolist()[:20]:
        issues.append(
            _reject("physical_limit_exceeded", f"{column} is outside approved bounds", int(row), column)
        )


def _reject(code: str, message: str, row: int | None = None, column: str | None = None) -> ValidationIssue:
    return ValidationIssue(level=ValidationLevel.REJECT, code=code, message=message, row=row, column=column)


def _warning(code: str, message: str) -> ValidationIssue:
    return ValidationIssue(level=ValidationLevel.WARNING, code=code, message=message)


def _report(
    sha: str,
    source_rows: int,
    normalized_rows: int,
    issues: list[ValidationIssue],
    conversions: list[str],
) -> ValidationReport:
    if any(issue.level == ValidationLevel.REJECT for issue in issues):
        outcome = ValidationLevel.REJECT
    elif issues:
        outcome = ValidationLevel.WARNING
    else:
        outcome = ValidationLevel.PASS
    return ValidationReport(
        source_sha256=sha,
        source_row_count=source_rows,
        normalized_row_count=normalized_rows,
        outcome=outcome,
        issues=issues,
        applied_conversions=conversions,
    )
