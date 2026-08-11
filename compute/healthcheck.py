"""Container health check for the worker status file."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path


def status_is_fresh(path: Path, max_age_seconds: float) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        observed = float(payload["observed_at_epoch_seconds"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False
    return 0 <= time.time() - observed <= max_age_seconds


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status-file", type=Path, required=True)
    parser.add_argument("--max-age-seconds", type=float, default=90)
    args = parser.parse_args()
    raise SystemExit(0 if status_is_fresh(args.status_file, args.max_age_seconds) else 1)


if __name__ == "__main__":
    main()
