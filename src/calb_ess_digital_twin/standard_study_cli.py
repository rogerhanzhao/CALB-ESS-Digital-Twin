"""CLI for one complete, immutable standard SOH study bundle."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

from .standard_study import StandardStudyRequest, write_standard_study_bundle


def load_request(path: Path) -> StandardStudyRequest:
    with path.open("r", encoding="utf-8") as source:
        raw: Any = yaml.safe_load(source)
    return StandardStudyRequest.model_validate(raw)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run a standard exposure/SOH study and create an immutable audit bundle."
    )
    parser.add_argument("request_yaml", type=Path)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    if args.output_directory.exists():
        parser.error("output_directory already exists; study versions must not be overwritten")

    artifact, manifest = write_standard_study_bundle(
        load_request(args.request_yaml), args.output_directory
    )
    print(f"Study version: {manifest.study_version}")
    print(f"Result version: {manifest.result_version}")
    print(f"Annual points: {len(artifact.soh_result.points)}")
    print(f"Engineering review eligible: {artifact.soh_result.engineering_review_eligible}")
    print(f"Warranty eligible: {artifact.soh_result.warranty_eligible}")
    print(f"Bundle: {args.output_directory}")
    return 0 if artifact.soh_result.engineering_review_eligible else 2


if __name__ == "__main__":
    raise SystemExit(main())
