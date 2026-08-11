"""Immutable evidence bundle for a validated physical dataset revision."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .cycle_metrics import CycleMetricPolicy, CycleMetricReport, derive_cycle_metrics
from .import_validation import (
    ColumnMapping,
    ImportManifest,
    TestType,
    ValidationLevel,
    ValidationPolicy,
    validate_csv_import,
)


class DatasetRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = "V0.2"
    revision_id: str = Field(min_length=1, max_length=120)
    dataset_id: str = Field(min_length=1, max_length=120)
    revision: str = Field(min_length=1, max_length=80)
    mapping_version: str = Field(min_length=1, max_length=80)
    cleaning_rule_version: str = Field(min_length=1, max_length=80)
    code_revision: str = Field(min_length=7, max_length=64)
    manifest: ImportManifest
    mappings: tuple[ColumnMapping, ...] = Field(min_length=1)
    validation_policy: ValidationPolicy
    cycle_metric_policy: CycleMetricPolicy | None = None

    @model_validator(mode="after")
    def cycle_policy_matches_test_type(self) -> DatasetRevisionRequest:
        if self.manifest.test_type == TestType.CYCLE_AGING and self.cycle_metric_policy is None:
            raise ValueError("cycle ageing revisions require an explicit cycle_metric_policy")
        if self.manifest.test_type != TestType.CYCLE_AGING and self.cycle_metric_policy is not None:
            raise ValueError("cycle_metric_policy is only valid for cycle ageing revisions")
        return self


class DatasetRevisionFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_name: str
    content_type: str
    byte_count: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class DatasetRevisionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = "V0.2"
    revision_id: str
    dataset_id: str
    revision: str
    source_sha256: str
    validation_outcome: ValidationLevel
    source_row_count: int = Field(ge=0)
    normalized_row_count: int = Field(ge=0)
    canonical_available: bool
    cycle_metrics_available: bool
    total_absolute_throughput_ah: float | None = Field(default=None, ge=0)
    total_equivalent_full_cycles: float | None = Field(default=None, ge=0)


class DatasetRevisionManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = "V0.2"
    revision_id: str
    dataset_id: str
    revision: str
    source_sha256: str
    validation_outcome: ValidationLevel
    calibration_eligible: bool
    files: tuple[DatasetRevisionFile, ...]


def write_dataset_revision_bundle(
    source_csv: Path,
    request: DatasetRevisionRequest,
    output_directory: Path,
) -> tuple[DatasetRevisionResult, DatasetRevisionManifest]:
    """Validate source evidence and atomically publish a non-overwriting revision bundle."""

    if output_directory.exists():
        raise FileExistsError(f"dataset revision bundle is immutable: {output_directory}")
    imported = validate_csv_import(
        source_csv,
        request.manifest,
        list(request.mappings),
        request.validation_policy,
    )
    metrics: CycleMetricReport | None = None
    if imported.normalized is not None and request.cycle_metric_policy is not None:
        metrics = derive_cycle_metrics(imported.normalized, request.cycle_metric_policy)

    result = DatasetRevisionResult(
        revision_id=request.revision_id,
        dataset_id=request.dataset_id,
        revision=request.revision,
        source_sha256=imported.report.source_sha256,
        validation_outcome=imported.report.outcome,
        source_row_count=imported.report.source_row_count,
        normalized_row_count=imported.report.normalized_row_count,
        canonical_available=imported.normalized is not None,
        cycle_metrics_available=metrics is not None,
        total_absolute_throughput_ah=(
            metrics.total_absolute_throughput_ah if metrics is not None else None
        ),
        total_equivalent_full_cycles=(
            metrics.total_equivalent_full_cycles if metrics is not None else None
        ),
    )

    output_directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_directory.name}-", dir=output_directory.parent
    ) as temporary:
        staging = Path(temporary) / output_directory.name
        staging.mkdir()
        _write_json(staging / "revision-request.json", request.model_dump(mode="json"))
        _write_json(staging / "validation-report.json", imported.report.model_dump(mode="json"))
        _write_json(staging / "dataset-revision-result.json", result.model_dump(mode="json"))
        if imported.normalized is not None:
            imported.normalized.to_csv(
                staging / "canonical.csv", index=False, lineterminator="\n"
            )
        if metrics is not None:
            _write_json(staging / "cycle-metrics.json", metrics.model_dump(mode="json"))
        files = tuple(
            _file_record(path)
            for path in sorted(staging.iterdir(), key=lambda item: item.name)
        )
        manifest = DatasetRevisionManifest(
            revision_id=request.revision_id,
            dataset_id=request.dataset_id,
            revision=request.revision,
            source_sha256=imported.report.source_sha256,
            validation_outcome=imported.report.outcome,
            calibration_eligible=imported.report.outcome == ValidationLevel.PASS,
            files=files,
        )
        _write_json(staging / "revision-manifest.json", manifest.model_dump(mode="json"))
        staging.replace(output_directory)
    return result, manifest


def verify_dataset_revision_bundle(
    request: DatasetRevisionRequest, output_directory: Path
) -> tuple[DatasetRevisionResult, DatasetRevisionManifest]:
    """Verify identities and every manifest checksum without trusting file names alone."""

    manifest = DatasetRevisionManifest.model_validate_json(
        (output_directory / "revision-manifest.json").read_text(encoding="utf-8")
    )
    result = DatasetRevisionResult.model_validate_json(
        (output_directory / "dataset-revision-result.json").read_text(encoding="utf-8")
    )
    stored_request = DatasetRevisionRequest.model_validate_json(
        (output_directory / "revision-request.json").read_text(encoding="utf-8")
    )
    if stored_request != request:
        raise ValueError("stored dataset revision request does not match retry request")
    identities = (request.revision_id, request.dataset_id, request.revision)
    if identities != (manifest.revision_id, manifest.dataset_id, manifest.revision) or identities != (
        result.revision_id,
        result.dataset_id,
        result.revision,
    ):
        raise ValueError("dataset revision bundle identities do not match")
    expected_names = {item.file_name for item in manifest.files} | {"revision-manifest.json"}
    actual_names = {path.name for path in output_directory.iterdir() if path.is_file()}
    if actual_names != expected_names:
        raise ValueError("dataset revision bundle file set does not match manifest")
    for record in manifest.files:
        path = output_directory / record.file_name
        if path.stat().st_size != record.byte_count or _sha256(path.read_bytes()) != record.sha256:
            raise ValueError(f"dataset revision artifact failed integrity check: {record.file_name}")
    if result.source_sha256 != manifest.source_sha256:
        raise ValueError("dataset revision source checksum identities do not match")
    return result, manifest


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _file_record(path: Path) -> DatasetRevisionFile:
    content = path.read_bytes()
    content_type = "text/csv; charset=utf-8" if path.suffix == ".csv" else "application/json"
    return DatasetRevisionFile(
        file_name=path.name,
        content_type=content_type,
        byte_count=len(content),
        sha256=_sha256(content),
    )


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
