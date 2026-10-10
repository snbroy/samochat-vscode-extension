#!/usr/bin/env python3
"""Validate chat JSONL and split it deterministically into train/validation/test."""
import argparse
import json
import random
import re
from pathlib import Path

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
]
ALLOWED_ROLES = {"system", "user", "assistant"}


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
        if not isinstance(row, dict) or not isinstance(row.get("messages"), list):
            raise ValueError(f"{path}:{line_no}: expected an object with a messages array")
        roles = []
        for index, message in enumerate(row["messages"]):
            if (
                not isinstance(message, dict)
                or message.get("role") not in ALLOWED_ROLES
                or not isinstance(message.get("content"), str)
            ):
                raise ValueError(
                    f"{path}:{line_no}: message {index} must have an allowed role and string content"
                )
            roles.append(message["role"])
            for pattern in SECRET_PATTERNS:
                if pattern.search(message["content"]):
                    raise ValueError(f"{path}:{line_no}: possible secret detected; redact it before training")
        if "user" not in roles or "assistant" not in roles:
            raise ValueError(f"{path}:{line_no}: each record needs at least one user and assistant message")
        rows.append(row)
    if len(rows) < 3:
        raise ValueError("Need at least 3 records to create train/validation/test splits")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--train-ratio", type=float, default=0.8)
    parser.add_argument("--validation-ratio", type=float, default=0.1)
    parser.add_argument("--test-ratio", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    ratios = [args.train_ratio, args.validation_ratio, args.test_ratio]
    if any(ratio <= 0 for ratio in ratios) or abs(sum(ratios) - 1.0) > 1e-6:
        parser.error("ratios must all be positive and sum to 1.0")
    rows = load_jsonl(Path(args.input))
    random.Random(args.seed).shuffle(rows)
    count = len(rows)
    train_count = max(1, int(count * args.train_ratio))
    validation_count = max(1, int(count * args.validation_ratio))
    if train_count + validation_count >= count:
        train_count = count - 2
        validation_count = 1
    splits = {
        "train": rows[:train_count],
        "validation": rows[train_count : train_count + validation_count],
        "test": rows[train_count + validation_count :],
    }
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    for name, items in splits.items():
        target = output / f"{name}.jsonl"
        target.write_text(
            "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items),
            encoding="utf-8",
        )
        print(f"{name}: {len(items)} examples -> {target}")
    print(f"Validated {count} examples. Tiny seed sets are for pipeline smoke tests only.")


if __name__ == "__main__":
    main()
