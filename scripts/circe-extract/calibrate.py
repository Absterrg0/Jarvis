"""Calibrate a fail-closed joint complete-frame int8 policy (calibration-only).

The command evaluates the frozen calibration split with the exported int8
model, then chooses action and span confidence thresholds JOINTLY against
the complete frame (raw action plus the exact span set, offsets are Python
codepoints). Action-only thresholds (train.py thresholds.json) are NOT a
readiness signal; neither is this output. Calibration selects valid
thresholds for inference gating only -- it NEVER declares readiness.
Readiness requires the evaluate.py fixed user gate on the held-out test
split (raw_action >= .95, complete_frame >= .90, useful_auto >= .80,
wrong_auto <= .01, fp32+int8). A calibrated policy with low useful-auto
coverage (e.g. useful 15/140) is still valid thresholds with
readiness False. Precision is
conserved: the int8 artifact is scored, no model or ONNX file is rewritten,
and no existing thresholds.json is touched. It writes a separate policy:

  /home/abstergo/.local/share/circe-experiments/extract-v07/train-env/bin/python \\
    scripts/circe-extract/calibrate.py \\
    --model-dir .../extract-v08/v08-small-s7 \\
    --calib .../extract-v08/data/calibration.jsonl \\
    --out .../extract-v08/v08-small-s7/policy-thresholds.json

Labels are dynamic (roles-v1 for new models, v077 sidecars for old
inspectable artifacts). Row validation runs before any model load. If no
pair meets the maximum accepted-extraction error rate, the output is an
abstain-all policy.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from evaluate import assert_aligned, load_rows, wilson  # noqa: E402
from inference import Extractor  # noqa: E402


SAFE_ABSTAIN_THRESHOLD = math.nextafter(1.0, 2.0)


def span_key(span: dict) -> tuple:
    return (span["start"], span["end"], span["label"])


def _candidates(_values: list[float]) -> list[float]:
    """Use a fixed coarse grid so calibration cannot chase one confidence."""
    return [round(index * 0.05, 2) for index in range(21)]


def score_policy(preds: list[dict], golds: list[dict],
                 action_threshold: float, token_threshold: float) -> dict:
    """Score a pair of thresholds using complete frame correctness."""
    assert_aligned(preds, golds, "calibration")
    accepted = useful = wrong = 0
    for pred, gold in zip(preds, golds):
        span_conf = pred.get("span_conf_min")
        allowed = (
            pred["raw_action"] != "clarify"
            and pred["action_confidence"] >= action_threshold
            and (span_conf is None or span_conf >= token_threshold)
            and not pred.get("truncated", False)
            and not pred.get("overflow", False)
        )
        if not allowed:
            continue
        accepted += 1
        frame = (
            pred["raw_action"] == gold["action"]
            and {span_key(s) for s in pred["spans"]}
            == {span_key(s) for s in gold.get("spans", [])}
        )
        if frame:
            useful += 1
        else:
            wrong += 1
    n = len(golds)
    return {
        "n": n,
        "accepted_count": accepted,
        "accepted_rate": round(accepted / max(n, 1), 4),
        "accepted_rate_wilson": wilson(accepted / max(n, 1), n),
        "useful_auto_count": useful,
        "useful_auto": round(useful / max(n, 1), 4),
        "useful_auto_wilson": wilson(useful / max(n, 1), n),
        "request_error_count": wrong,
        "wrong_auto": round(wrong / max(n, 1), 4),
        "wrong_auto_wilson": wilson(wrong / max(n, 1), n),
        "accepted_error": round(wrong / max(accepted, 1), 4),
        "accepted_error_wilson": wilson(wrong / max(accepted, 1), accepted),
    }


def choose_policy(preds: list[dict], golds: list[dict],
                  max_wrong_rate: float = 0.01) -> dict:
    """Choose maximum-coverage valid thresholds, or return abstain-all.

    Calibration-only: a "calibrated" result means the thresholds are valid
    for inference gating (Extractor consumes clarify_threshold /
    token_threshold). It is NEVER a readiness signal -- readiness is always
    False here and requires the evaluate.py fixed gate on test. Low
    useful-auto coverage (e.g. 15/140) is still valid thresholds, not ready.
    """
    action_values = [float(p["action_confidence"]) for p in preds]
    token_values = [float(p["span_conf_min"]) for p in preds
                    if p.get("span_conf_min") is not None]
    candidates = []
    for action_threshold in _candidates(action_values):
        for token_threshold in _candidates(token_values):
            metrics = score_policy(preds, golds, action_threshold, token_threshold)
            wrong_rate = metrics["request_error_count"] / max(len(golds), 1)
            accepted_error = metrics["request_error_count"] / max(
                metrics["accepted_count"], 1)
            if (metrics["accepted_count"] > 0
                    and wrong_rate <= max_wrong_rate
                    and accepted_error <= max_wrong_rate):
                candidates.append((
                    metrics["accepted_count"],
                    metrics["useful_auto_count"],
                    -action_threshold,
                    -token_threshold,
                    action_threshold,
                    token_threshold,
                    metrics,
                ))
    if not candidates:
        return {
            "status": "abstain-all",
            "valid": False,
            "clarify_threshold": SAFE_ABSTAIN_THRESHOLD,
            "token_threshold": SAFE_ABSTAIN_THRESHOLD,
            "max_wrong_rate": max_wrong_rate,
            "calibration_mode": "joint-complete-frame",
            "calibration_only": True,
            "readiness": False,
            "note": ("calibration-only: valid thresholds for inference gating; "
                     "NOT a readiness signal (readiness requires evaluate.py "
                     "fixed gate on test)"),
            "metrics": score_policy(
                preds, golds, SAFE_ABSTAIN_THRESHOLD, SAFE_ABSTAIN_THRESHOLD),
        }
    _, _, _, _, action_threshold, token_threshold, metrics = max(candidates)
    return {
        "status": "calibrated",
        "valid": True,
        "clarify_threshold": action_threshold,
        "token_threshold": token_threshold,
        "max_wrong_rate": max_wrong_rate,
        "calibration_mode": "joint-complete-frame",
        "calibration_only": True,
        "readiness": False,
        "note": ("calibration-only: valid thresholds for inference gating; "
                 "NOT a readiness signal (readiness requires evaluate.py "
                 "fixed gate on test)"),
        "metrics": metrics,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Joint complete-frame int8 calibration (action + span confidence).")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--calib", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-wrong-rate", type=float, default=0.01)
    args = ap.parse_args()
    if not 0 <= args.max_wrong_rate <= 1:
        raise SystemExit("--max-wrong-rate must be between 0 and 1")

    # Row validation before any model resource launch (load_rows checks
    # ids and exact text; Extractor verifies sidecar labels dynamically).
    rows = load_rows(args.calib)
    ex = Extractor(args.model_dir, use_int8=True)
    preds = []
    for row in rows:
        pred = ex.predict(row["text"])
        pred["id"] = row["id"]
        preds.append(pred)
    assert_aligned(preds, rows, "calibration")
    policy = choose_policy(preds, rows, args.max_wrong_rate)
    # Fail closed: calibration output is never a readiness signal, even if a
    # future choose_policy variant forgets the flag.
    policy["readiness"] = False
    policy.setdefault("calibration_only", True)
    if "calibration_mode" not in policy:
        policy = {**policy, "calibration_mode": "joint-complete-frame",
                  "readiness": False, "calibration_only": True}
    output = {
        "model_dir": os.path.abspath(args.model_dir),
        "precision": "int8",
        "max_len": ex.max_len,
        "label_schema": getattr(ex, "label_schema", None),
        "label_set": sorted(getattr(ex, "label_set", set())),
        "calibration_file": os.path.abspath(args.calib),
        "calibration_rows": len(rows),
        **policy,
    }
    parent = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(parent, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(output, fh, indent=2)
    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
