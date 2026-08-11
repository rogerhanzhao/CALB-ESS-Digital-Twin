"""CLI for building a standard-scenario exposure artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

from .exposure import StandardExposurePlan, build_standard_exposure


def load_plan(path: Path) -> StandardExposurePlan:
    with path.open("r", encoding="utf-8") as source:
        raw: Any = yaml.safe_load(source)
    return StandardExposurePlan.model_validate(raw)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a versioned annual exposure trajectory for a standard scenario."
    )
    parser.add_argument("plan_yaml", type=Path)
    parser.add_argument("artifact_json", type=Path)
    args = parser.parse_args()
    if args.artifact_json.exists():
        parser.error("artifact_json already exists; scenario versions must not be overwritten")

    artifact = build_standard_exposure(load_plan(args.plan_yaml))
    args.artifact_json.parent.mkdir(parents=True, exist_ok=True)
    args.artifact_json.write_text(
        json.dumps(artifact.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Scenario version: {artifact.standard_scenario_version}")
    print(f"Annual points: {len(artifact.exposure_points)}")
    print(f"Artifact: {args.artifact_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
