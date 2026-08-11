"""End-to-end standard study orchestration and immutable local artifact bundle."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .dispatch import StandardExposureArtifact, StandardExposurePlan, build_standard_exposure
from .soh_engine import (
    CalibrationApprovalStatus,
    CalibrationResult,
    ExtrapolationRequest,
    ExtrapolationResult,
    extrapolate_soh,
)


class StandardStudyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    study_version: str = Field(min_length=1)
    result_version: str = Field(min_length=1)
    exposure_plan: StandardExposurePlan
    calibration: CalibrationResult
    calibration_approval_status: CalibrationApprovalStatus


class StandardStudyArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal["V0.2"] = "V0.2"
    study_version: str
    result_version: str
    exposure: StandardExposureArtifact
    soh_result: ExtrapolationResult


class ArtifactFileRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_name: str
    content_type: Literal["application/json"] = "application/json"
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(ge=0)


class StandardStudyManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = "V0.2"
    study_version: str
    result_version: str
    standard_scenario_version: str
    calibration_id: str
    calibration_model_version: str
    calibration_dataset_revision_ids: tuple[str, ...]
    calibration_approval_status: CalibrationApprovalStatus
    scenario_code_revision: str
    calibration_code_revision: str
    engineering_review_eligible: bool
    warranty_eligible: Literal[False] = False
    files: tuple[ArtifactFileRecord, ...]


def run_standard_study(request: StandardStudyRequest) -> StandardStudyArtifact:
    """Build nominal exposure and evaluate the reduced-order SOH trajectory."""

    exposure = build_standard_exposure(request.exposure_plan)
    soh_result = extrapolate_soh(
        ExtrapolationRequest(
            result_version=request.result_version,
            standard_scenario_version=exposure.standard_scenario_version,
            calibration=request.calibration,
            calibration_approval_status=request.calibration_approval_status,
            conditions=exposure.conditions,
            exposure_points=exposure.exposure_points,
        )
    )
    return StandardStudyArtifact(
        study_version=request.study_version,
        result_version=request.result_version,
        exposure=exposure,
        soh_result=soh_result,
    )


def write_standard_study_bundle(
    request: StandardStudyRequest, output_directory: Path
) -> tuple[StandardStudyArtifact, StandardStudyManifest]:
    """Atomically create a non-overwriting, checksum-addressed local study bundle."""

    if output_directory.exists():
        raise FileExistsError("output directory already exists; study versions are immutable")
    artifact = run_standard_study(request)
    output_directory.parent.mkdir(parents=True, exist_ok=True)

    payloads = {
        "study-request.json": _json_bytes(request),
        "scenario-exposure.json": _json_bytes(artifact.exposure),
        "soh-result.json": _json_bytes(artifact.soh_result),
    }
    records = tuple(
        ArtifactFileRecord(
            file_name=name,
            sha256=hashlib.sha256(content).hexdigest(),
            byte_count=len(content),
        )
        for name, content in payloads.items()
    )
    manifest = StandardStudyManifest(
        study_version=request.study_version,
        result_version=request.result_version,
        standard_scenario_version=request.exposure_plan.standard_scenario_version,
        calibration_id=request.calibration.calibration_id,
        calibration_model_version=request.calibration.model_version,
        calibration_dataset_revision_ids=request.calibration.dataset_revision_ids,
        calibration_approval_status=request.calibration_approval_status,
        scenario_code_revision=request.exposure_plan.code_revision,
        calibration_code_revision=request.calibration.code_revision,
        engineering_review_eligible=artifact.soh_result.engineering_review_eligible,
        files=records,
    )
    payloads["manifest.json"] = _json_bytes(manifest)

    with tempfile.TemporaryDirectory(
        prefix=f".{output_directory.name}-", dir=output_directory.parent
    ) as temporary_name:
        temporary = Path(temporary_name)
        for name, content in payloads.items():
            (temporary / name).write_bytes(content)
        temporary.replace(output_directory)
    return artifact, manifest


def _json_bytes(model: BaseModel) -> bytes:
    return (
        json.dumps(
            model.model_dump(mode="json"),
            indent=2,
            ensure_ascii=False,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
