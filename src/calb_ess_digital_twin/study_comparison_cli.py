"""CLI for a non-overwriting standard study comparison artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

from .dispatch import StandardExposureArtifact
from .soh_engine import ExtrapolationResult
from .standard_study import (
    StandardStudyArtifact,
    StandardStudyManifest,
    StandardStudyRequest,
)
from .study_comparison import (
    StudyComparisonConfiguration,
    StudyComparisonRequest,
    StudyVersionEvidence,
    compare_standard_studies,
)


def load_configuration(path: Path) -> StudyComparisonConfiguration:
    with path.open("r", encoding="utf-8") as source:
        raw: Any = yaml.safe_load(source)
    return StudyComparisonConfiguration.model_validate(raw)


def load_bundle(directory: Path) -> StudyVersionEvidence:
    manifest = StandardStudyManifest.model_validate_json(
        (directory / "manifest.json").read_text(encoding="utf-8")
    )
    expected_files = {"study-request.json", "scenario-exposure.json", "soh-result.json"}
    records = {record.file_name: record for record in manifest.files}
    if set(records) != expected_files:
        raise ValueError("study manifest does not contain the exact required evidence files")
    payloads: dict[str, bytes] = {}
    for name, record in records.items():
        content = (directory / name).read_bytes()
        if len(content) != record.byte_count:
            raise ValueError(f"study bundle byte count mismatch: {name}")
        if hashlib.sha256(content).hexdigest() != record.sha256:
            raise ValueError(f"study bundle checksum mismatch: {name}")
        payloads[name] = content
    request = StandardStudyRequest.model_validate_json(payloads["study-request.json"])
    exposure = StandardExposureArtifact.model_validate_json(payloads["scenario-exposure.json"])
    soh_result = ExtrapolationResult.model_validate_json(payloads["soh-result.json"])
    artifact = StandardStudyArtifact(
        study_version=manifest.study_version,
        result_version=manifest.result_version,
        exposure=exposure,
        soh_result=soh_result,
    )
    return StudyVersionEvidence(request=request, artifact=artifact, manifest=manifest)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare two like-for-like standard study result versions."
    )
    parser.add_argument("baseline_bundle", type=Path)
    parser.add_argument("current_bundle", type=Path)
    parser.add_argument("configuration_yaml", type=Path)
    parser.add_argument("comparison_json", type=Path)
    args = parser.parse_args()
    if args.comparison_json.exists():
        parser.error("comparison_json already exists; comparison versions are immutable")

    configuration = load_configuration(args.configuration_yaml)
    result = compare_standard_studies(
        StudyComparisonRequest(
            comparison_version=configuration.comparison_version,
            baseline=load_bundle(args.baseline_bundle),
            current=load_bundle(args.current_bundle),
            policy=configuration.policy,
        )
    )
    args.comparison_json.parent.mkdir(parents=True, exist_ok=True)
    args.comparison_json.write_text(
        json.dumps(result.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Comparison version: {result.comparison_version}")
    print(f"Final capacity delta: {result.final_capacity_delta_fraction:+.6f}")
    print(f"Validity changed years: {list(result.validity_changed_years)}")
    print(f"Artifact: {args.comparison_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
