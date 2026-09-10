"""Evaluate exported extractor models (fp32 + int8). TRAINING ONLY.

Runs on onnxruntime alone (no torch/transformers). Scoring an unchanged
model is allowed; this never trains and never tunes thresholds: the sweep
below is report-only on calibration.jsonl, and the gate runs on test once.

  /home/abstergo/.local/share/jarvis-experiments/extract-v07/train-env/bin/python \\
    scripts/jarvis-extract/evaluate.py --model-dir .../extract-v08/v08-small-s7 \\
    --calib .../extract-v08/data/calibration.jsonl \\
    --test .../extract-v08/data/test.jsonl \\
    --out .../extract-v08/v08-small-s7/eval.json

Row validation (ids, exact text, codepoint bounds) runs before any model
load. Labels are dynamic: roles-v1 (DESTINATION TASK SUBJECT EXCLUDED
CORRECTION PROVIDER MODEL EFFORT) for new models, v077 sidecar labels for
old inspectable artifacts. Complete-frame = raw action plus the exact
span set (offsets are Python codepoints). Per-label exact-span P/R/F1 is
reported for every gold label; instr_recall stays as a legacy v077 alias.

Reports raw_action accuracy (model proposal) alongside policy action
accuracy (after clarify gating), because gating abstains to clarify and
would otherwise read as 0. Fails (exit 2) on the fixed user gate for both
precisions, int8 regression, raw bounds violations, or clarify-everything
collapse. Pass --policy to evaluate a separate joint-calibrated policy
sidecar (calibrate.py). Precision is conserved: fp32 and int8 are scored
independently with no fallback.

Note: gating is action-confidence OR min-span-token confidence, but only
the action threshold is swept on calibration. The span/token threshold is
a fixed operating point unless a joint calibrate.py policy is supplied.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inference import Extractor  # noqa: E402  # ORT + stdlib only


def load_rows(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(l) for l in f if l.strip()]
    if not rows:
        raise ValueError(f"empty evaluation split: {path}")
    ids = [r.get("id") for r in rows]
    if any(not isinstance(row.get("text"), str) for row in rows):
        raise ValueError(f"every evaluation row needs string text: {path}")
    if any(not isinstance(row_id, str) or not row_id for row_id in ids):
        raise ValueError(f"every evaluation row needs a non-empty id: {path}")
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate evaluation row id in {path}")
    return rows


def assert_aligned(preds: list[dict], golds: list[dict], split: str = "rows") -> None:
    """Reject count, id, or exact-text drift before any metric is computed."""
    if len(preds) != len(golds):
        raise ValueError(
            f"{split} prediction/gold count mismatch: {len(preds)} != {len(golds)}")
    seen_pred_ids: set[str] = set()
    for index, (pred, gold) in enumerate(zip(preds, golds)):
        if pred.get("text") != gold.get("text"):
            raise ValueError(f"{split} text mismatch at row {index}")
        pred_id, gold_id = pred.get("id"), gold.get("id")
        if pred_id is not None or gold_id is not None:
            if pred_id != gold_id:
                raise ValueError(
                    f"{split} id mismatch at row {index}: {pred_id!r} != {gold_id!r}")
            if not isinstance(pred_id, str) or not pred_id:
                raise ValueError(f"{split} prediction at row {index} has invalid id")
            if pred_id in seen_pred_ids:
                raise ValueError(f"{split} duplicate prediction id: {pred_id}")
            seen_pred_ids.add(pred_id)


def predict_rows(extractor: Extractor, rows: list[dict]) -> list[dict]:
    """Predict in row order while carrying ids into the alignment check."""
    preds = []
    for row in rows:
        pred = extractor.predict(row["text"])
        pred["id"] = row["id"]
        preds.append(pred)
    assert_aligned(preds, rows)
    return preds


def span_key(sp: dict) -> tuple:
    return (sp["start"], sp["end"], sp["label"])


def wilson(p: float, n: int, z: float = 1.96) -> list[float]:
    if n <= 0:
        return [0.0, 1.0]
    d = 1.0 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round(max(0.0, (c - m) / d), 4), round(min(1.0, (c + m) / d), 4)]


def score_rows(preds: list[dict], golds: list[dict]) -> dict:
    assert_aligned(preds, golds)
    n = len(golds)
    raw_ok = sum(p["raw_action"] == g["action"] for p, g in zip(preds, golds))
    pol_ok = sum(p["action"] == g["action"] for p, g in zip(preds, golds))
    tp = fp = fn = 0
    instr_ok = instr_n = 0
    per_label: dict[str, dict[str, int]] = {}
    whole = 0
    # User gates (raw / complete-frame / useful-auto / wrong-auto).
    # complete_frame: raw action plus the exact span set.
    # useful_auto: accepted (non-clarify) AND fully correct.
    # wrong_auto: accepted but wrong action or wrong spans.
    useful = wrong_auto = 0
    host_keys = ("catalog_missing", "node", "stale")
    wrong_host = 0
    bounds_bad = 0
    trunc = 0
    by_cat: dict[str, dict] = {}
    for p, g in zip(preds, golds):
        ps, gs = {span_key(s) for s in p["spans"]}, {span_key(s) for s in g["spans"]}
        tp += len(ps & gs)
        fp += len(ps - gs)
        fn += len(gs - ps)
        frame_ok = p["raw_action"] == g["action"] and ps == gs
        if frame_ok:
            whole += 1
        accepted = p["action"] != "clarify"
        if accepted and p["action"] == g["action"] and ps == gs:
            useful += 1
        if accepted and not frame_ok:
            wrong_auto += 1
            ctx = g.get("context", {}) or {}
            if any(k in ctx for k in host_keys) or g.get("host") == "unknown":
                wrong_host += 1
        for s in p["spans"]:
            if not (0 <= s["start"] < s["end"] <= len(g["text"])):
                bounds_bad += 1
        if p.get("truncated"):
            trunc += 1
        for s in g.get("spans", []):
            lab = s.get("label")
            if not isinstance(lab, str):
                continue
            slot = per_label.setdefault(lab, {"n": 0, "ok": 0})
            slot["n"] += 1
            if span_key(s) in ps:
                slot["ok"] += 1
            if lab == "INSTRUCTION":
                instr_n += 1
                if span_key(s) in ps:
                    instr_ok += 1
        c = by_cat.setdefault(str(g.get("category", "?")),
                              {"n": 0, "raw_ok": 0, "pol_ok": 0,
                               "tp": 0, "fp": 0, "fn": 0, "whole": 0})
        c["n"] += 1
        c["raw_ok"] += p["raw_action"] == g["action"]
        c["pol_ok"] += p["action"] == g["action"]
        c["tp"] += len(ps & gs)
        c["fp"] += len(ps - gs)
        c["fn"] += len(gs - ps)
        c["whole"] += (p["raw_action"] == g["action"] and ps == gs)
    prec = tp / max(tp + fp, 1)
    rec = tp / max(tp + fn, 1)
    raw_acc = raw_ok / max(n, 1)
    pol_acc = pol_ok / max(n, 1)
    cats = {}
    for k, c in sorted(by_cat.items()):
        p_ = c["tp"] / max(c["tp"] + c["fp"], 1)
        r_ = c["tp"] / max(c["tp"] + c["fn"], 1)
        cats[k] = {"n": c["n"], "raw_action_acc": round(c["raw_ok"] / c["n"], 4),
                   "policy_action_acc": round(c["pol_ok"] / c["n"], 4),
                   "span_f1": round(2 * p_ * r_ / max(p_ + r_, 1e-9), 4),
                   "whole_correct": round(c["whole"] / c["n"], 4)}
    accepted = n - sum(p["action"] == "clarify" for p in preds)
    clarify = n - accepted
    per_label_out = {
        lab: {"n": v["n"], "ok": v["ok"],
              "recall": round(v["ok"] / max(v["n"], 1), 4)}
        for lab, v in sorted(per_label.items())
    }
    return {
        "n": n, "unique_texts": len({g["text"] for g in golds}),
        "raw_action_correct": raw_ok,
        "policy_action_correct": pol_ok,
        "raw_action_acc": round(raw_acc, 4),
        "raw_action_acc_wilson": wilson(raw_acc, n),
        "policy_action_acc": round(pol_acc, 4),
        "policy_action_acc_wilson": wilson(pol_acc, n),
        "span_p": round(prec, 4), "span_r": round(rec, 4),
        "span_f1": round(2 * prec * rec / max(prec + rec, 1e-9), 4),
        "instr_recall": round(instr_ok / max(instr_n, 1), 4),
        "instr_n": instr_n,
        "per_label_recall": per_label_out,
        "whole_correct": round(whole / max(n, 1), 4),
        "complete_frame_acc": round(whole / max(n, 1), 4),
        "accepted_count": accepted,
        "accepted_rate": round(accepted / max(n, 1), 4),
        "accepted_rate_wilson": wilson(accepted / max(n, 1), n),
        "useful_auto_count": useful,
        "useful_auto": round(useful / max(n, 1), 4),
        "useful_auto_wilson": wilson(useful / max(n, 1), n),
        "request_error_count": wrong_auto,
        "wrong_auto_count": wrong_auto,
        "wrong_auto": round(wrong_auto / max(n, 1), 4),
        "wrong_auto_wilson": wilson(wrong_auto / max(n, 1), n),
        "accepted_error": round(wrong_auto / max(accepted, 1), 4),
        "accepted_error_wilson": wilson(wrong_auto / max(accepted, 1), accepted),
        "wrong_auto_host": wrong_host,
        "wrong_auto_linguistic": wrong_auto - wrong_host,
        "raw_bounds_bad": bounds_bad, "truncated": trunc,
        "clarify_count": clarify,
        "clarify_rate": round(clarify / max(n, 1), 4),
        "coverage": round(sum(p["action"] != "clarify" for p in preds) / max(n, 1), 4),
        "by_category": cats,
    }


# Fixed user gate: raw_action >= .95, complete_frame >= .90,
# useful_auto >= .80, wrong_auto <= .01 on fp32. Hardcoded on purpose:
# relaxed flags previously produced a pass verdict below user targets,
# so tunable thresholds are banned from the shipping decision. The
# --diagnostic sweep stays report-only and never feeds the verdict.
FIXED_MIN_RAW = 0.95
FIXED_MIN_FRAME = 0.90
FIXED_MIN_USEFUL = 0.80
FIXED_MAX_WRONG = 0.01
FIXED_MAX_INT8_DROP = 0.02
FIXED_MAX_CLARIFY_RATE = 0.95


def gate_fixed(test_fp32: dict, test_int8: dict) -> list[str]:
    """Apply the fixed user gate independently to fp32 and int8 metrics."""
    f, q = test_fp32, test_int8
    fails = []
    def collect(metric: str, predicate, target: str) -> None:
        bad = []
        for label, metrics in (("fp32", f), ("int8", q)):
            if predicate(metrics[metric]):
                bad.append(f"{label}={metrics[metric]}")
        if bad:
            fails.append(f"{metric} {target} ({', '.join(bad)})")

    collect("raw_action_acc", lambda value: value < FIXED_MIN_RAW,
            f"< {FIXED_MIN_RAW}")
    collect("complete_frame_acc", lambda value: value < FIXED_MIN_FRAME,
            f"< {FIXED_MIN_FRAME}")
    collect("useful_auto", lambda value: value < FIXED_MIN_USEFUL,
            f"< {FIXED_MIN_USEFUL}")
    collect("wrong_auto", lambda value: value > FIXED_MAX_WRONG,
            f"> {FIXED_MAX_WRONG}")
    if f["raw_bounds_bad"] != 0 or q["raw_bounds_bad"] != 0:
        fails.append("span bounds violation: start/end outside exact raw text "
                     f"(fp32={f['raw_bounds_bad']}, int8={q['raw_bounds_bad']})")
    if f["clarify_rate"] >= FIXED_MAX_CLARIFY_RATE \
            or q["clarify_rate"] >= FIXED_MAX_CLARIFY_RATE:
        fails.append("clarify-everything: coverage collapsed "
                     f"(fp32={f['clarify_rate']}, int8={q['clarify_rate']})")
    for k in ("raw_action_acc", "complete_frame_acc", "useful_auto"):
        if f[k] - q[k] > FIXED_MAX_INT8_DROP:
            fails.append(f"int8 drop on {k}: {f[k]} -> {q[k]}")
    return fails
def sweep(preds: list[dict], golds: list[dict]) -> list[dict]:
    """Report-only action-threshold sweep on calibration rows.

    selected(t) = confidence >= t; false(t) = selected and raw wrong.
    The frozen policy value is marked; nothing is rewritten.
    """
    assert_aligned(preds, golds, "calibration")
    out = []
    for x in range(1, 20):
        t = round(x * 0.05, 2)
        sel = [p for p in preds if p["action_confidence"] >= t]
        bad = sum(1 for p, g in zip(preds, golds)
                  if p["action_confidence"] >= t and p["raw_action"] != g["action"])
        out.append({"threshold": t, "selected": len(sel),
                    "coverage": round(len(sel) / max(len(preds), 1), 4),
                    "false": bad,
            "false_among_selected": round(bad / max(len(sel), 1), 4),
            "false_wilson": wilson(bad / max(len(sel), 1), len(sel))})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--calib", required=True, help="calibration.jsonl (sweep is report-only)")
    ap.add_argument("--test", required=True, help="test.jsonl (gate runs once)")
    ap.add_argument("--policy", default=None,
                    help="optional separate policy-thresholds.json sidecar")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    cal_rows, test_rows = load_rows(args.calib), load_rows(args.test)
    # Deployment binding: the report names the exact artifact it evaluated
    # (model_dir) and the policy it gated with, so the host can refuse a
    # report that gates one candidate while inference runs another.
    # Precision binds through the separate fp32/int8 sections below plus
    # the deployment --int8 flag. Absolute paths: calibrate.py already
    # writes policy model_dir absolute, and the host compares verbatim.
    report: dict = {"gate_note": "FIXED user gate on fp32 and int8 extractor metrics: "
                                 "raw_action >= .95, complete_frame >= .90, "
                                 "useful_auto >= .80, wrong_auto <= .01; "
                                 "span F1 is diagnostic only",
                    "model_dir": os.path.abspath(args.model_dir),
                    "policy": args.policy}
    per_case: dict = {}
    for tag, use_int8 in (("fp32", False), ("int8", True)):
        ex = Extractor(args.model_dir, use_int8=use_int8,
                       policy_path=args.policy)
        cal_preds = predict_rows(ex, cal_rows)
        test_preds = predict_rows(ex, test_rows)
        report[tag] = {
            "calib": score_rows(cal_preds, cal_rows),
            "test": score_rows(test_preds, test_rows),
            "sweep_calib": sweep(cal_preds, cal_rows),
            "frozen_thresholds": [ex.clarify_threshold, ex.token_threshold],
        }
        per_case[tag] = [
            {"id": g.get("id"), "category": g.get("category"),
             "text": g["text"], "expected_action": g["action"],
             "expected_spans": g.get("spans", []),
             "raw_action": p["raw_action"],
             "action_confidence": p["action_confidence"],
             "policy_action": p["action"],
             "spans": p["spans"], "span_conf_min": p["span_conf_min"],
             "truncated": p["truncated"]}
            for p, g in zip(test_preds, test_rows)
        ]
    report["per_case"] = per_case
    f, q = report["fp32"]["test"], report["int8"]["test"]
    fails = gate_fixed(f, q)
    report["verdict"] = "pass" if not fails else "fail"
    report["fails"] = fails
    report["gate"] = {"raw_action_acc": FIXED_MIN_RAW,
                      "complete_frame_acc": FIXED_MIN_FRAME,
                      "useful_auto": FIXED_MIN_USEFUL,
                      "wrong_auto": FIXED_MAX_WRONG,
                      "fixed": True}
    print(json.dumps({k: v for k, v in report.items() if k != "per_case"}, indent=2))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
    raise SystemExit(0 if not fails else 2)


if __name__ == "__main__":
    main()
