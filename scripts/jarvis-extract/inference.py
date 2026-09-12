"""Deployment inference for the supervised Jarvis command extractor.

TRAINING ARTIFACT, DEPLOYMENT-SAFE IMPORTS ONLY: stdlib + onnxruntime
(+ numpy, already present via onnxruntime). Never import
torch, transformers, or tokenizers here; the training env owns those.

Model dir layout (written by train.py):
  model_fp32.onnx | model_int8.onnx, vocab.txt, actions.json,
  bio_labels.json, thresholds.json, manifest.json, label_schema.json (v08+)

Contract (data lane owns the dataset; this file only reads its output):
  JSONL {id, family, provenance, split, text, action,
         spans:[{start, end, label}]}
  offsets are Python Unicode codepoints into the exact raw text. The
  canonical TS adapter converts codepoints to UTF-16 (see
  packages/jarvis-core/src/extraction.ts). Label schema roles-v1:
  DESTINATION TASK SUBJECT EXCLUDED CORRECTION PROVIDER MODEL EFFORT.
  Actions (13): start continue steer queue stop status review reroute
  focus-project focus-task list-projects converse clarify (clarify maps to
  decline/unsupported downstream; no generative instruction is emitted).

  Role notes for the adapter (not enforced here): DESTINATION/CORRECTION
  spans are full routing wrappers containing `in X` / `to X` etc; the
  adapter derives the named value with bounded wrapper syntax without
  splitting/rejoining source. The full wrapper including comma/space is
  kept so the host can validate and delete it. Non-wrapper names stay as
  the span text and the host handles authorized focus. SUBJECT/EXCLUDED
  never authorize. MODEL/EFFORT echo the source slice; dual distinct refs
  are rejected downstream.

Backward compatibility: v077 artifacts (PROJECT/TASK/PROVIDER/MODEL/
ROUTING/INSTRUCTION/NODE/CONTROL) stay inspectable through their own
label sidecars. The extractor loads actions/bio_labels dynamically from
the model dir and verifies shape only, so old precision files run without
duplicating old training formats.

Inference rules:
  - Overflow is explicit: content longer than max_len-2 sets truncated=true.
    Truncated requests are policy-level clarify outcomes and never return an
    accepted extraction.
  - PAD is never inferred: the ONNX feed carries only [CLS..SEP] live tokens.
  - raw_action + action_confidence are the model proposal; action is the
    policy outcome after clarify gating. Gating is action-confidence OR
    min-span-token confidence. The span/token threshold is a fixed operating
    point, not a calibrated readiness rate (readiness needs calibrate.py
    joint complete-frame policy).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import unicodedata
from pathlib import Path

try:
    import numpy as _np
except ImportError:  # pragma: no cover - numpy ships with onnxruntime closure
    _np = None

try:
    import onnxruntime as ort
except ImportError:  # deferred so --help and tokenizer tests work without ORT
    ort = None

LABELS = (
    "DESTINATION", "TASK", "SUBJECT", "EXCLUDED", "CORRECTION", "PROVIDER",
    "MODEL", "EFFORT",
)
# v077 sidecars stay loadable for inspection; training never emits these.
OLD_LABELS = (
    "PROJECT", "TASK", "PROVIDER", "MODEL", "ROUTING", "INSTRUCTION", "NODE",
    "CONTROL",
)
LABEL_SCHEMA_VERSION = "roles-v1"
ACTIONS = (
    "start", "continue", "steer", "queue", "stop", "status", "review",
    "reroute", "focus-project", "focus-task", "list-projects", "converse",
    "clarify",
)
BIO_O = "O"
SAFE_ABSTAIN_THRESHOLD = math.nextafter(1.0, 2.0)


def bio_label_list() -> list[str]:
    out = [BIO_O]
    for lab in LABELS:
        out += [f"B-{lab}", f"I-{lab}"]
    return out


def verify_bio_labels(id2bio: object) -> list[str]:
    """Verify a loaded bio_labels sidecar shape; allow old or new sets.

    Returns the label list on success. Old v077 sidecars (PROJECT etc)
    stay inspectable: shape is verified, the exact set is not forced to
    roles-v1. Training always writes roles-v1 via bio_label_list().
    """
    if not isinstance(id2bio, list) or not id2bio or id2bio[0] != BIO_O:
        raise ValueError("bio_labels sidecar must be a list starting with 'O'")
    if len(id2bio) % 2 != 1:
        raise ValueError("bio_labels sidecar must be O plus B-/I- pairs")
    seen: set[str] = set()
    for idx, tag in enumerate(id2bio):
        if not isinstance(tag, str) or not tag:
            raise ValueError(f"bio_labels[{idx}] must be a non-empty string")
        if idx == 0:
            continue
        prefix, sep, lab = tag.partition("-")
        if sep != "-" or prefix not in ("B", "I") or not lab:
            raise ValueError(f"bio_labels[{idx}] must look like B-<LABEL>: {tag!r}")
        seen.add(lab)
    # B- and I- must pair per label; no duplicates beyond the pair.
    for lab in seen:
        if f"B-{lab}" not in id2bio or f"I-{lab}" not in id2bio:
            raise ValueError(f"bio_labels missing B-/I- pair for {lab!r}")
    if len(seen) * 2 + 1 != len(id2bio):
        raise ValueError("bio_labels sidecar has duplicate or extra tags")
    return list(id2bio)


def verify_actions(actions: object) -> list[str]:
    """Verify an actions sidecar shape (13 known actions, order preserved)."""
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions sidecar must be a non-empty list")
    for idx, action in enumerate(actions):
        if not isinstance(action, str) or not action:
            raise ValueError(f"actions[{idx}] must be a non-empty string")
    if len(set(actions)) != len(actions):
        raise ValueError("actions sidecar has duplicates")
    # New and v077 artifacts share the same 13 actions; unknown sets are
    # rejected so a swapped sidecar cannot silently remap heads.
    if set(actions) != set(ACTIONS):
        raise ValueError(
            f"actions sidecar must contain exactly the 13 known actions: "
            f"got {sorted(actions)!r}"
        )
    return list(actions)


def label_set_of(id2bio: list[str]) -> set[str]:
    """Strip BIO prefixes, returning the plain label set (e.g. roles-v1)."""
    out: set[str] = set()
    for tag in id2bio:
        if tag == BIO_O:
            continue
        out.add(tag.split("-", 1)[1])
    return out


def _strip_accent_1to1(ch: str) -> str:
    """Accent-strip one codepoint to one codepoint (HF uncased parity).

    Pretrained uncased tokenizers strip accents before WordPiece
    ("café" -> "cafe"). NFD-decomposition would change codepoint counts
    and break our exact offsets, so map precomposed characters to their
    single ASCII base only when the decomposition is base + marks;
    otherwise keep the char (both sides then miss vocab the same way).
    """
    if ord(ch) < 128:
        return ch
    d = unicodedata.normalize("NFD", ch)
    if len(d) >= 2 and len(d[0]) == 1 and all(
        unicodedata.category(c).startswith("M") for c in d[1:]
    ):
        return d[0]
    return ch


def _lookup_form(basic_token: str) -> str:
    return "".join(_strip_accent_1to1(c) for c in basic_token)


def _is_punct(ch: str) -> bool:
    cp = ord(ch)
    if 33 <= cp <= 47 or 58 <= cp <= 64 or 91 <= cp <= 96 or 123 <= cp <= 126:
        return True
    return unicodedata.category(ch).startswith("P")


def basic_tokenize_with_offsets(text: str) -> list[tuple[str, int, int]]:
    """Lowercase-split raw text into basic tokens, keeping codepoint offsets."""
    lowered = text.lower()
    # Guard the rare case where lower() changes codepoint count (e.g. U+0130).
    # Fall back to per-char lowering that preserves 1:1 alignment.
    if len(lowered) != len(text):
        lowered = "".join(c.lower() if len(c.lower()) == 1 else c for c in text)
    toks: list[tuple[str, int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        if lowered[i].isspace():
            i += 1
            continue
        if _is_punct(lowered[i]):
            toks.append((lowered[i], i, i + 1))
            i += 1
            continue
        j = i
        while j < n and not lowered[j].isspace() and not _is_punct(lowered[j]):
            j += 1
        toks.append((lowered[i:j], i, j))
        i = j
    return toks


def wordpiece_tokenize(
    basic_token: str, start: int, vocab: dict[str, int], unk: str = "[UNK]"
) -> list[tuple[str, int, int]]:
    """Greedy longest-match WordPiece; subtoken offsets tile [start, ...).

    Lookup uses the accent-stripped form (1:1 codepoints, so offsets into
    the original raw text stay exact); e.g. "café" looks up "cafe" while
    the span still covers the raw "café".
    """
    lookup = _lookup_form(basic_token)
    assert len(lookup) == len(basic_token), "accent strip must stay 1:1"
    if lookup in vocab:
        return [(lookup, start, start + len(basic_token))]
    out: list[tuple[str, int, int]] = []
    pos = 0
    end = len(lookup)
    while pos < end:
        cur_end = end
        found = None
        while cur_end > pos:
            piece = lookup[pos:cur_end]
            if pos > 0:
                piece = "##" + piece
            if piece in vocab:
                found = (piece, start + pos, start + cur_end)
                break
            cur_end -= 1
        if found is None:
            return [(unk, start, start + len(basic_token))]
        out.append(found)
        pos = found[2] - start
    return out


def tokenize_with_offsets(
    text: str, vocab: dict[str, int], max_len: int = 64
) -> tuple[list[str], list[int], list[int], list[int]]:
    """Full padded tokenize for TRAINING parity -> (tokens, ids, starts, ends).

    Special tokens use offset (-1, -1). Truncation keeps CLS/SEP and the
    first max_len-2 content tokens. Offsets are Unicode codepoints.
    Inference does NOT use the PAD tail; see encode_live().
    """
    if max_len < 2:
        raise ValueError("max_len must be at least 2 for [CLS] and [SEP]")
    unk_id = vocab.get("[UNK]", 100)
    cls, sep, pad = "[CLS]", "[SEP]", "[PAD]"
    tokens = [cls]
    starts = [-1]
    ends = [-1]
    for word, s, e in basic_tokenize_with_offsets(text):
        for tok, ts, te in wordpiece_tokenize(word, s, vocab):
            tokens.append(tok)
            starts.append(ts)
            ends.append(te)
    tokens.append(sep)
    starts.append(-1)
    ends.append(-1)
    if len(tokens) > max_len:
        tokens = tokens[: max_len - 1] + [sep]
        starts = starts[: max_len - 1] + [-1]
        ends = ends[: max_len - 1] + [-1]
    ids = [vocab.get(t, unk_id) for t in tokens]
    pad_id = vocab.get(pad, 0)
    while len(ids) < max_len:
        tokens.append(pad)
        starts.append(-1)
        ends.append(-1)
        ids.append(pad_id)
    return tokens, ids, starts, ends


def encode_live(
    text: str, vocab: dict[str, int], max_len: int = 64
) -> tuple[list[str], list[int], list[int], list[int], bool]:
    """Live-token encode for INFERENCE: no PAD is ever fed to the model.

    Returns (tokens, ids, starts, ends, truncated). Tokens are
    [CLS] + first max_len-2 content tokens + [SEP]; mask is all ones.
    """
    if max_len < 2:
        raise ValueError("max_len must be at least 2 for [CLS] and [SEP]")
    unk_id = vocab.get("[UNK]", 100)
    tokens = ["[CLS]"]
    starts = [-1]
    ends = [-1]
    for word, s, e in basic_tokenize_with_offsets(text):
        for tok, ts, te in wordpiece_tokenize(word, s, vocab):
            tokens.append(tok)
            starts.append(ts)
            ends.append(te)
    tokens.append("[SEP]")
    starts.append(-1)
    ends.append(-1)
    truncated = len(tokens) > max_len
    if truncated:
        tokens = tokens[: max_len - 1] + ["[SEP]"]
        starts = starts[: max_len - 1] + [-1]
        ends = ends[: max_len - 1] + [-1]
    ids = [vocab.get(t, unk_id) for t in tokens]
    return tokens, ids, starts, ends, truncated


def load_vocab(vocab_path: str | os.PathLike) -> dict[str, int]:
    vocab: dict[str, int] = {}
    with open(vocab_path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            vocab[line.rstrip("\n")] = i
    return vocab


def _policy_threshold(value: object, name: str) -> float:
    """Validate a confidence threshold, including the explicit abstain value."""
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        threshold = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(threshold):
        raise ValueError(f"{name} must be finite")
    if threshold == SAFE_ABSTAIN_THRESHOLD:
        return threshold
    if not 0.0 <= threshold <= 1.0:
        raise ValueError(
            f"{name} must be between 0 and 1 or the abstain sentinel "
            f"{SAFE_ABSTAIN_THRESHOLD!r}"
        )
    return threshold


def _policy_max_len(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("max_len must be an integer")
    if value < 2:
        raise ValueError("model max_len must be at least 2")
    return value


def _softmax(logits) -> list[float]:
    m = max(logits)
    exps = [math.exp(v - m) for v in logits]
    s = sum(exps)
    return [v / s for v in exps]


def decode_spans(
    tokens: list[str],
    starts: list[int],
    ends: list[int],
    tag_ids: list[int],
    tok_conf: list[float],
    id2bio: list[str],
) -> tuple[list[dict], float | None]:
    """BIO tags -> strict spans [{start, end, label, confidence}].

    No text is stored: offsets index the caller's exact raw string.
    Confidence per span is the min token confidence inside it.
    """
    spans: list[dict] = []
    cur: dict | None = None
    cur_label = ""
    cur_min = 1.0
    for i, (tok, s, e, tid) in enumerate(zip(tokens, starts, ends, tag_ids)):
        if tok in ("[CLS]", "[SEP]", "[PAD]") or s < 0:
            if cur is not None:
                cur["confidence"] = round(cur_min, 4)
                spans.append(cur)
                cur = None
                cur_label = ""
                cur_min = 1.0
            continue
        bio = id2bio[tid] if 0 <= tid < len(id2bio) else BIO_O
        if bio == BIO_O:
            if cur is not None:
                cur["confidence"] = round(cur_min, 4)
                spans.append(cur)
                cur = None
                cur_label = ""
                cur_min = 1.0
            continue
        prefix, _, lab = bio.partition("-")
        c = tok_conf[i] if i < len(tok_conf) else 0.0
        if prefix == "B" or lab != cur_label or cur is None:
            if cur is not None:
                cur["confidence"] = round(cur_min, 4)
                spans.append(cur)
            cur = {"start": s, "end": e, "label": lab}
            cur_label = lab
            cur_min = c
        else:  # I- continuation of the same label: extend end, track min
            assert cur is not None
            cur["end"] = e
            cur_min = min(cur_min, c)
    if cur is not None:
        cur["confidence"] = round(cur_min, 4)
        spans.append(cur)
    span_min = min((s["confidence"] for s in spans), default=None)
    return spans, span_min


class Extractor:
    """Thin ONNX wrapper. Session uses 2 threads to match the CPU budget."""

    def __init__(self, model_dir: str | os.PathLike, use_int8: bool = False,
                 policy_path: str | os.PathLike | None = None):
        if ort is None:
            raise RuntimeError("onnxruntime is not installed in this environment")
        d = Path(model_dir)
        name = "model_int8.onnx" if use_int8 else "model_fp32.onnx"
        mp = d / name
        if not mp.is_file():
            raise FileNotFoundError(f"missing precision file (no fallback): {mp}")
        required_sidecars = ["vocab.txt", "actions.json", "bio_labels.json"]
        if policy_path is None:
            required_sidecars.append("thresholds.json")
        for sidecar in required_sidecars:
            if not (d / sidecar).is_file():
                raise FileNotFoundError(f"missing model sidecar: {d / sidecar}")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(mp), sess_options=opts)
        self.precision = "int8" if use_int8 else "fp32"
        self.vocab = load_vocab(d / "vocab.txt")
        # Dynamic labels from sidecars: old v077 artifacts stay inspectable
        # via their own PROJECT/... sidecars; new models carry roles-v1.
        # Shape is verified, the exact set is not forced here.
        self.actions = verify_actions(
            json.loads((d / "actions.json").read_text(encoding="utf-8")))
        self.id2bio: list[str] = verify_bio_labels(
            json.loads((d / "bio_labels.json").read_text(encoding="utf-8")))
        self.label_set = label_set_of(self.id2bio)
        schema_path = d / "label_schema.json"
        self.label_schema: str | None = None
        if schema_path.is_file():
            schema_blob = json.loads(schema_path.read_text(encoding="utf-8"))
            if not isinstance(schema_blob, dict):
                raise ValueError(f"label schema sidecar must be an object: {schema_path}")
            version = schema_blob.get("version")
            if not isinstance(version, str) or not version:
                raise ValueError(f"label schema version must be a string: {schema_path}")
            schema_labels = schema_blob.get("labels")
            if isinstance(schema_labels, list) and set(schema_labels) != self.label_set:
                raise ValueError(
                    f"label_schema labels do not match bio_labels: {schema_path}")
            self.label_schema = version
        if policy_path is None:
            th_path = d / "thresholds.json"
        else:
            th_path = Path(policy_path)
            if not th_path.is_file():
                raise FileNotFoundError(f"missing policy sidecar: {th_path}")
        th = json.loads(th_path.read_text(encoding="utf-8"))
        if not isinstance(th, dict):
            raise ValueError(f"policy sidecar must contain an object: {th_path}")
        policy_model_dir = th.get("model_dir")
        if policy_model_dir is not None:
            if not isinstance(policy_model_dir, str) or not policy_model_dir:
                raise ValueError(f"policy model_dir must be a non-empty path: {th_path}")
            if Path(policy_model_dir).resolve() != d.resolve():
                raise ValueError(
                    f"policy model_dir does not match model directory: "
                    f"{policy_model_dir!r} != {str(d.resolve())!r}"
                )
        policy_precision = th.get("precision")
        if policy_precision is not None and policy_precision not in ("fp32", "int8"):
            raise ValueError(
                f"policy precision must be 'fp32' or 'int8': {policy_precision!r}"
            )
        for key in ("clarify_threshold", "token_threshold", "max_len"):
            if key not in th:
                raise ValueError(f"policy sidecar missing {key}: {th_path}")
        self.policy_path = str(th_path)
        self.clarify_threshold = _policy_threshold(
            th["clarify_threshold"], "clarify_threshold")
        # Fixed operating point; no calibrated span rate exists (see eval note).
        self.token_threshold = _policy_threshold(th["token_threshold"], "token_threshold")
        self.max_len = _policy_max_len(th["max_len"])

    def predict(self, text: str) -> dict:
        tokens, ids, starts, ends, truncated = encode_live(
            text, self.vocab, self.max_len
        )
        if _np is None:
            raise RuntimeError("numpy is required for ONNX inference")
        mask = [1] * len(ids)  # live tokens only; PAD is never inferred
        feeds = {
            "input_ids": _np.array([ids], dtype=_np.int64),
            "attention_mask": _np.array([mask], dtype=_np.int64),
        }
        names = [o.name for o in self.session.get_outputs()]
        outs = self.session.run(names, feeds)
        by_name = dict(zip(names, outs))
        if "action_logits" in by_name:
            a_logits, t_logits = by_name["action_logits"], by_name["token_logits"]
        else:
            a_logits, t_logits = (outs[0], outs[1]) if outs[1].ndim == 3 else (outs[1], outs[0])
        probs = _softmax([float(v) for v in a_logits[0]])
        best = max(range(len(probs)), key=lambda i: probs[i])
        raw_action = self.actions[best]
        # Keep the decision value unrounded. Reports may round it, but policy
        # calibration and live gating must compare the same probability.
        action_confidence = float(probs[best])
        tok_rows = t_logits[0]
        seq_tags = [int(v) for v in _np.argmax(tok_rows, axis=-1)[: len(tokens)]]
        tok_conf: list[float] = []
        for row in tok_rows[: len(tokens)]:
            m = max(float(v) for v in row)
            exps = [math.exp(float(v) - m) for v in row]
            s = sum(exps)
            tok_conf.append(max(v / s for v in exps))
        spans, span_conf_min = decode_spans(
            tokens, starts, ends, seq_tags, tok_conf, self.id2bio)
        action = raw_action
        if probs[best] < self.clarify_threshold and action != "clarify":
            action = "clarify"
        elif (span_conf_min is not None and span_conf_min < self.token_threshold
                and action != "clarify"):
            action = "clarify"
        # A truncated request is incomplete evidence. Keep the explicit
        # overflow bit and fail closed so callers cannot accept a prefix.
        if truncated and action != "clarify":
            action = "clarify"
        return {
            "text": text,
            "raw_action": raw_action,
            "action_confidence": action_confidence,
            "action": action,
            "action_probs": {a: round(probs[i], 4) for i, a in enumerate(self.actions)},
            "spans": spans,
            "tokens": tokens,
            "token_conf": [round(c, 4) for c in tok_conf],
            "span_conf_min": span_conf_min,
            "truncated": truncated,
            "clarify_threshold": self.clarify_threshold,
            "token_threshold": self.token_threshold,
            "precision": self.precision,
        }


def strict_proposal(pred: dict, row_id=None) -> dict:
    """Batch contract: Director-eval compatible proposal plus strict spans.

    Keeps spans strict [{start, end, label, confidence}] with no span text,
    and carries the composition boundary alongside: exact text, policy
    action plus raw_action, confidence in both casings, full action_probs,
    span_conf_min, explicit truncated/overflow, thresholds, and precision.
    The eval adapter pairs by id when present, derives confidence from
    actionConfidence/action_confidence/action_probs, and uses the explicit
    overflow flag (never the PAD heuristic) for truncation.
    """
    out: dict = {
        "text": pred["text"],
        "action": pred["action"],
        "raw_action": pred["raw_action"],
        "actionConfidence": pred["action_confidence"],
        "action_confidence": pred["action_confidence"],
        "action_probs": pred["action_probs"],
        "spans": [{"start": s["start"], "end": s["end"], "label": s["label"],
                   "confidence": s["confidence"]} for s in pred["spans"]],
        "span_conf_min": pred["span_conf_min"],
        "truncated": pred["truncated"],
        "overflow": pred["truncated"],
        "clarify_threshold": pred["clarify_threshold"],
        "token_threshold": pred["token_threshold"],
        "precision": pred["precision"],
    }
    if row_id is not None:
        out = {"id": row_id, **out}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Run the Jarvis extractor ONNX model.")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--int8", action="store_true")
    ap.add_argument("--policy", default=None,
                    help="optional separate policy-thresholds.json sidecar")
    ap.add_argument("--text", default=None)
    ap.add_argument("--input", default=None, help="JSONL with {id?, text} per line")
    ap.add_argument("--output", default=None, help="strict proposal JSONL out")
    ap.add_argument("--with-meta", action="store_true",
                    help="batch only: add a separate meta object per line")
    args = ap.parse_args()
    ex = Extractor(args.model_dir, use_int8=args.int8, policy_path=args.policy)
    if args.text is not None:
        print(json.dumps(ex.predict(args.text), ensure_ascii=False))
    elif args.input is not None:
        if not args.output:
            raise SystemExit("batch mode needs --input plus --output")
        with open(args.input, encoding="utf-8") as fin, \
                open(args.output, "w", encoding="utf-8") as fout:
            for line in fin:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                if not isinstance(row.get("text"), str):
                    raise SystemExit("input line missing string 'text'")
                pred = ex.predict(row["text"])
                out = strict_proposal(pred, row.get("id"))
                if args.with_meta:
                    out["meta"] = {"tokens": pred["tokens"],
                                   "token_conf": pred["token_conf"]}
                fout.write(json.dumps(out, ensure_ascii=False) + "\n")
    else:
        raise SystemExit("pass --text or --input plus --output")


if __name__ == "__main__":
    main()
