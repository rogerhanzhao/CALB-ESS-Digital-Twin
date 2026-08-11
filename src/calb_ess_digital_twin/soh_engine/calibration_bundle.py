"""Immutable evidence bundle for one semi-empirical calibration fit."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .calibration import CalibrationRequest, CalibrationResult, fit_semi_empirical_model


class CalibrationBundleFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_name: str
    byte_count: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class CalibrationBundleManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["V0.2"] = "V0.2"
    calibration_id: str
    model_version: str
    code_revision: str
    dataset_revision_ids: tuple[str, ...]
    approval_eligible: bool
    files: tuple[CalibrationBundleFile, ...]


def write_calibration_bundle(
    request: CalibrationRequest, output_directory: Path
) -> tuple[CalibrationResult, CalibrationBundleManifest]:
    if output_directory.exists():
        raise FileExistsError(f"calibration bundle is immutable: {output_directory}")
    result = fit_semi_empirical_model(request)
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{output_directory.name}-", dir=output_directory.parent
    ) as temporary:
        staging = Path(temporary) / output_directory.name
        staging.mkdir()
        _write_json(staging / "calibration-request.json", request.model_dump(mode="json"))
        _write_json(staging / "calibration-result.json", result.model_dump(mode="json"))
        files = tuple(_file_record(path) for path in sorted(staging.iterdir()))
        manifest = CalibrationBundleManifest(
            calibration_id=result.calibration_id,
            model_version=result.model_version,
            code_revision=result.code_revision,
            dataset_revision_ids=result.dataset_revision_ids,
            approval_eligible=result.approval_eligible,
            files=files,
        )
        _write_json(staging / "calibration-manifest.json", manifest.model_dump(mode="json"))
        staging.replace(output_directory)
    return result, manifest


def verify_calibration_bundle(
    request: CalibrationRequest, output_directory: Path
) -> tuple[CalibrationResult, CalibrationBundleManifest]:
    stored_request = CalibrationRequest.model_validate_json(
        (output_directory / "calibration-request.json").read_text(encoding="utf-8")
    )
    if stored_request != request:
        raise ValueError("stored calibration bundle belongs to a different request")
    result = CalibrationResult.model_validate_json(
        (output_directory / "calibration-result.json").read_text(encoding="utf-8")
    )
    manifest = CalibrationBundleManifest.model_validate_json(
        (output_directory / "calibration-manifest.json").read_text(encoding="utf-8")
    )
    identity = (request.calibration_id, request.model_version, request.code_revision)
    if identity != (result.calibration_id, result.model_version, result.code_revision):
        raise ValueError("calibration request and result identities do not match")
    if identity != (manifest.calibration_id, manifest.model_version, manifest.code_revision):
        raise ValueError("calibration manifest identity does not match request")
    if result.dataset_revision_ids != manifest.dataset_revision_ids:
        raise ValueError("calibration dataset evidence does not match manifest")
    if result.approval_eligible != manifest.approval_eligible:
        raise ValueError("calibration eligibility does not match manifest")
    expected = {item.file_name for item in manifest.files} | {"calibration-manifest.json"}
    actual = {path.name for path in output_directory.iterdir() if path.is_file()}
    if actual != expected:
        raise ValueError("calibration bundle file set does not match manifest")
    for record in manifest.files:
        content = (output_directory / record.file_name).read_bytes()
        if len(content) != record.byte_count or _sha256(content) != record.sha256:
            raise ValueError(f"calibration artifact failed integrity check: {record.file_name}")
    return result, manifest


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _file_record(path: Path) -> CalibrationBundleFile:
    content = path.read_bytes()
    return CalibrationBundleFile(
        file_name=path.name, byte_count=len(content), sha256=_sha256(content)
    )


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()
