"""CLI for producing a versioned reduced-order SOH trajectory artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

from .extrapolation import ExtrapolationRequest, extrapolate_soh


def load_request(path: Path) -> ExtrapolationRequest:
    with path.open("r", encoding="utf-8") as source:
        raw: Any = yaml.safe_load(source)
    return ExtrapolationRequest.model_validate(raw)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a versioned SOH trajectory with validity-envelope evidence."
    )
    parser.add_argument("request_yaml", type=Path)
    parser.add_argument("result_json", type=Path)
    args = parser.parse_args()
    result = extrapolate_soh(load_request(args.request_yaml))
    args.result_json.parent.mkdir(parents=True, exist_ok=True)
    try:
        with args.result_json.open("x", encoding="utf-8") as destination:
            destination.write(
                json.dumps(result.model_dump(mode="json"), indent=2, ensure_ascii=False)
                + "\n"
            )
    except FileExistsError:
        parser.error("result_json already exists; result versions must not be overwritten")
    print(f"Within validity envelope: {result.all_points_within_validity_envelope}")
    print(f"Engineering review eligible: {result.engineering_review_eligible}")
    print(f"Warranty eligible: {result.warranty_eligible}")
    print(f"Result: {args.result_json}")
    return 0 if result.engineering_review_eligible else 2


if __name__ == "__main__":
    raise SystemExit(main())
