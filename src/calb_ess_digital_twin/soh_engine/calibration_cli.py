"""CLI for producing a draft semi-empirical calibration artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

from .calibration import CalibrationRequest, fit_semi_empirical_model


def load_request(path: Path) -> CalibrationRequest:
    with path.open("r", encoding="utf-8") as source:
        raw: Any = yaml.safe_load(source)
    return CalibrationRequest.model_validate(raw)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fit an auditable draft SOH baseline from reviewed ageing observations."
    )
    parser.add_argument("request_yaml", type=Path)
    parser.add_argument("result_json", type=Path)
    args = parser.parse_args()
    if args.result_json.exists():
        parser.error("result_json already exists; calibration artifacts must not be overwritten")

    result = fit_semi_empirical_model(load_request(args.request_yaml))
    args.result_json.parent.mkdir(parents=True, exist_ok=True)
    args.result_json.write_text(
        json.dumps(result.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Calibration converged: {result.fit_converged}")
    print(f"Approval eligible: {result.approval_eligible}")
    print(f"Result: {args.result_json}")
    return 0 if result.approval_eligible else 2


if __name__ == "__main__":
    raise SystemExit(main())
