"""CLI for a non-overwriting standard study comparison artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

from .standard_study import (
    load_standard_study_bundle,
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
    request, artifact, manifest = load_standard_study_bundle(directory)
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
