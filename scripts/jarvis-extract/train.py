"""Train + export the supervised Jarvis command extractor. TRAINING ONLY.

Never imported by shipped code. Root runs this in the external venv
(2 CPU threads, <2.5 GiB, max 1200 s export-inclusive, NEW external
outdir outside Git):

  /home/abstergo/.local/share/jarvis-experiments/extract-v07/train-env/bin/python \\
    scripts/jarvis-extract/train.py \\
    --data-dir /tmp/opencode/aris-v08-data \\
    --out /tmp/opencode/aris-v08-out/v08-small-s7 \\
    --model-name google/bert_uncased_L-4_H-512_A-8 \\
    --revision 606e4d55252882ac25ba1f1d1a182075830f5a90 \\
    --local-files-only \\
    --label-schema roles-v1 --epochs 10 --batch 32 --max-len 96 \\
    --time-budget-s 1050 --warmup-ratio 0.1 --action-class-weight --seed 7

Budget is export-inclusive inside 1200 s: ~10 epochs x ~77 s (~770 s
at 504 rows / batch 32, 2 threads) plus fp32 export + int8 quant +
parity (~120 s) lands near ~900-1050 s. The time budget guards the epoch
loop and stops before an epoch when under 60 s remain, so the loop never
eats the export headroom. Threads are capped at 2 (OMP/MKL/torch/ORT,
DataLoader single-process) for the 2-thread cap.

Backbone: google/bert_uncased_L-4_H-512_A-8 (~28.8M params, cached).
The 4-layer 512-hidden encoder is the kept owner candidate shape (v077
evidence); no larger or generative instruction model is introduced.
Full finetune (head + backbone). License Apache-2.0, verified at download
from the model card and pinned in manifest.json with the exact revision.

Label schema roles-v1 (immutable output): DESTINATION TASK SUBJECT
EXCLUDED CORRECTION PROVIDER MODEL EFFORT. Actions stay the existing 13
(clarify maps to decline/unsupported downstream). Offsets are Python
Unicode codepoints; the TS adapter converts canonically to UTF-16.
DESTINATION/CORRECTION spans are full routing wrappers (`in X`, `to X`
etc); the adapter derives the named value with bounded wrapper syntax
without splitting/rejoining source. SUBJECT/EXCLUDED never authorize.
MODEL/EFFORT echo the source slice; dual distinct refs are rejected
downstream. No phrase blacklist, no new paid services.

Splits: train/dev select the model, calibration.jsonl sets a joint
complete-frame policy via calibrate.py only. The thresholds.json written
here is action-confidence-only and is NOT a readiness signal. test.jsonl
is never read here and never tunes anything. Datasets live outside Git.
Recovery without retraining:
  /home/abstergo/.local/share/jarvis-experiments/extract-v07/train-env/bin/python \\
    scripts/jarvis-extract/train.py --export-only \\
    --out /home/abstergo/.local/share/jarvis-experiments/extract-v08/v08-small-s7 \\
    --revision 606e4d55252882ac25ba1f1d1a182075830f5a90
With only model_fp32.onnx present this reuses it, rewrites any missing
sidecars, and produces model_int8.onnx. With checkpoint.pt present it
re-exports fp32 from the checkpoint first. Nothing retrains in this mode.
Output is immutable: training refuses any nonempty out dir unless
--force (overwrite) or --resume (explicit resume of an unfinished run
holding checkpoint.pt) is passed. --local-files-only resolves the pinned
backbone from the local HF cache and validates the cached README license
(Apache-2.0, no trust bypass: trust_remote_code stays False everywhere).
Restart (crash recovery, same dir):
  train.py --resume --out <run-dir> --epochs <more> [same data/model flags]
  Reloads weights/history (plus optimizer+RNG when the checkpoint holds
  them; older checkpoints restart weights-only and say so) and continues
  the epoch count. Compat of model/revision/labels/max_len is verified;
  weights are strict-loaded before any step.
Continuation (bounded extra training, NEW dir, source only read):
  train.py --warm-start <stable-checkpoint.pt> --out <new-dir> --epochs <few>
Checkpoints always bundle best-epoch-consistent state: best weights with
the optimizer/RNG/step captured at that same epoch. A weights-only
restart with no new improvement re-saves weights-only rather than
mixing best weights with latest optimizer state.
--token-class-weight (default off) rebalances the token loss with
balanced inverse-sqrt-frequency class weights (clipped at 5) counted on
train live tags only; dev/calibration rows never feed the weights.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inference import (  # noqa: E402  # shared pure-python tokenizer = train/infer parity
    ACTIONS,
    LABEL_SCHEMA_VERSION,
    LABELS,
    bio_label_list,
    encode_live,
    tokenize_with_offsets,
)

DEFAULT_MODEL = "google/bert_uncased_L-4_H-512_A-8"
DEFAULT_REVISION = "606e4d55252882ac25ba1f1d1a182075830f5a90"
DATA_ACTIONS = set(ACTIONS)
DATA_LABELS = set(LABELS)
LABEL_SCHEMA = LABEL_SCHEMA_VERSION
IGNORE = -100  # PAD token tag: excluded from loss and token accuracy


def set_seed(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed)
    except ImportError:
        pass
    import torch

    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)


def read_jsonl(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def validate_row(r: dict, expected_split: str | None = None) -> None:
    # Data-lane schema: {id, family, provenance?, split, text, action,
    # spans:[{start, end, label, text?}]} with codepoint offsets. No labels
    # outside roles-v1 are accepted here; v077 rows stay inspectable via
    # inference/evaluate sidecars, never by retraining through this path.
    assert isinstance(r.get("id"), str) and r["id"], "id must be non-empty"
    assert isinstance(r.get("family"), str) and r["family"], "family must be non-empty"
    assert isinstance(r.get("split"), str) and r["split"], "split must be non-empty"
    if expected_split is not None:
        assert r["split"] == expected_split, (
            f"split mismatch: row {r.get('id')!r} has {r['split']!r}, "
            f"expected {expected_split!r}")
    if "provenance" in r:
        assert isinstance(r["provenance"], (str, dict)), "provenance must be str or object"
    assert isinstance(r["text"], str) and len(r["text"]) > 0, "text must be exact raw"
    assert r["action"] in DATA_ACTIONS, f"bad action {r['action']}"
    spans = r.get("spans", None)
    assert isinstance(spans, list), "spans must be a list"
    for sp in spans:
        assert isinstance(sp, dict), f"bad span {sp!r}"
        assert sp["label"] in DATA_LABELS, f"bad label {sp.get('label')!r} (roles-v1 only)"
        assert isinstance(sp["start"], int) and isinstance(sp["end"], int)
        assert not isinstance(sp["start"], bool) and not isinstance(sp["end"], bool)
        assert 0 <= sp["start"] < sp["end"] <= len(r["text"]), f"bad offsets {sp}"
        # Offsets are Unicode codepoints; Python len() counts codepoints.
        # The TS adapter converts canonically to UTF-16; never split a
        # surrogate pair when deriving wrapper values downstream.
        if "text" in sp:
            # Char coverage: a carried span text must reproduce the source
            # slice exactly (wrappers keep comma/space, e.g. "In Foxglove,").
            assert sp["text"] == r["text"][sp["start"]:sp["end"]], (
                f"span text mismatch {sp!r}")
    ordered = sorted(spans, key=lambda s: (s["start"], s["end"]))
    for left, right in zip(ordered, ordered[1:]):
        assert right["start"] >= left["end"], f"overlap {left} vs {right}"


def check_no_overflow(rows: list[dict], vocab: dict, max_len: int) -> None:
    """Fail startup when any row overflows max_len (no silent truncation).

    max_len 96 is chosen so the v08 lane fits: content tokens plus CLS/SEP
    must fit. encode_live reports truncation explicitly without PAD; any
    truncated row fails here with its id instead of training on a prefix.
    """
    bad: list[str] = []
    for r in rows:
        _, _, _, _, truncated = encode_live(r["text"], vocab, max_len)
        if truncated:
            bad.append(str(r.get("id", "?")))
    if bad:
        shown = ", ".join(bad[:8])
        raise SystemExit(
            f"{len(bad)} row(s) overflow max_len={max_len} "
            f"(no silent truncation; first: {shown})")


def read_cached_license(snapshot_dir: str) -> str | None:
    """Read the cached model-card license without network.

    Parses the README.md frontmatter `license:` line from the pinned
    snapshot only. Returns None when absent/unparseable; the caller fails
    closed. Never weakens trust checks elsewhere.
    """
    path = os.path.join(snapshot_dir, "README.md")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped.lower().startswith("license:"):
                    return stripped.split(":", 1)[1].strip().strip("'\"")
    except OSError:
        return None
    return None


APACHE_LICENSES = ("apache-2.0", "Apache-2.0", "Apache 2.0")


def resolve_snapshot(model_name: str, revision: str | None,
                     local_only: bool) -> str:
    """Resolve the pinned snapshot from cache when requested, else download.

    --local-files-only uses the local HF cache exclusively (no remote
    model_info, no download). Missing cache fails fast with an explicit
    message instead of hanging on network.
    """
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(
            repo_id=model_name, revision=revision, local_files_only=local_only)
    except Exception as e:
        if local_only:
            raise SystemExit(
                f"cached snapshot missing for {model_name}@{revision}: "
                f"{type(e).__name__}: {e} (pass without --local-files-only "
                f"to allow download, or prefetch the pinned rev)") from e
        raise


def weighted_selection_loss(action_loss: float, token_loss: float,
                            token_weight: float) -> float:
    """Return the objective used to choose the best checkpoint."""
    return action_loss + token_weight * token_loss


def safe_abstain_threshold() -> float:
    """A threshold above every possible softmax confidence."""
    return math.nextafter(1.0, 2.0)


def checkpoint_metadata(blob: dict) -> tuple[list[str] | None, list[str] | None, int | None]:
    """Read model-shape metadata without assuming the current label set."""
    actions = blob.get("actions")
    bio_labels = blob.get("bio_labels")
    max_len = blob.get("max_len")
    return (
        list(actions) if actions is not None else None,
        list(bio_labels) if bio_labels is not None else None,
        int(max_len) if max_len is not None else None,
    )


def resume_mode(blob: dict) -> str:
    """Classify restart fidelity from checkpoint contents (pure, no torch).

    'exact' needs weights + optimizer + RNG snapshots; 'weights-optimizer'
    lacks RNG; anything older is an explicit weights-only warm restart, and
    must never be described as an exact resume.
    """
    has_opt = blob.get("optimizer") is not None
    has_rng = isinstance(blob.get("rng"), dict)
    if has_opt and has_rng:
        return "exact"
    if has_opt:
        return "weights-optimizer"
    return "weights-only"


def resume_init_from_history(history: list[dict]) -> tuple[int, float | None, int]:
    """Best epoch/loss and last global step from saved history (pure).

    Returns (-1, None, 0) for empty or unreadable history; malformed rows
    are skipped rather than aborting the restart.
    """
    best_ep, best_loss, last_step = -1, None, 0
    for row in history:
        try:
            loss = float(row["dev"]["loss"])
        except (KeyError, TypeError, ValueError):
            continue
        try:
            last_step = int(row.get("global_step", last_step))
        except (TypeError, ValueError):
            pass
        try:
            ep = int(row.get("epoch", -1))
        except (TypeError, ValueError):
            ep = -1
        if best_loss is None or loss < best_loss:
            best_loss, best_ep = loss, ep
    return best_ep, best_loss, last_step


def verify_checkpoint_compat(blob: dict, *, model: str, revision: str | None,
                             actions: list[str], bio_labels: list[str],
                             max_len: int) -> None:
    """Fail closed when a checkpoint does not match this run's config."""
    problems = []
    if blob.get("model") != model:
        problems.append(f"model {blob.get('model')!r} != {model!r}")
    if revision is not None and blob.get("revision") != revision:
        problems.append(f"revision {blob.get('revision')!r} != {revision!r}")
    if list(blob.get("actions") or []) != list(actions):
        problems.append("actions ordering differs")
    if list(blob.get("bio_labels") or []) != list(bio_labels):
        problems.append("bio_labels ordering differs")
    if blob.get("max_len") != max_len:
        problems.append(f"max_len {blob.get('max_len')!r} != {max_len!r}")
    if not isinstance(blob.get("state_dict"), dict):
        problems.append("no state_dict")
    if problems:
        raise SystemExit("checkpoint incompatible with this run: " + "; ".join(problems))


def strict_load_state_dict(model, state_dict: dict) -> None:
    """Load weights strictly; fail closed on any key/shape mismatch.

    This is the restart proof point: weights are verified inside the model
    before any optimizer step runs.
    """
    try:
        result = model.load_state_dict(state_dict, strict=True)
    except RuntimeError as e:
        raise SystemExit(f"checkpoint weights do not match model heads: {e}") from e
    missing = list(getattr(result, "missing_keys", []) or [])
    unexpected = list(getattr(result, "unexpected_keys", []) or [])
    if missing or unexpected:
        raise SystemExit(
            f"checkpoint key mismatch: missing={missing[:5]} "
            f"unexpected={unexpected[:5]}")


def snapshot_rng() -> dict:
    """Capture RNG states for future exact resumes (minimal, additive)."""
    snap: dict = {"python": random.getstate()}
    try:
        import numpy as np

        snap["numpy"] = np.random.get_state()
    except ImportError:
        pass
    try:
        import torch

        snap["torch"] = torch.get_rng_state()
    except ImportError:
        pass
    return snap


def token_class_weights(tag_seqs: list[list[str]], classes: list[str],
                        cap: float = 5.0) -> dict[str, float]:
    """Balanced inverse-sqrt-frequency weights over BIO tags (pure).

    Counts only the caller-supplied live tags (train non-IGNORE positions;
    PAD already excluded). Rare tags are emphasized via sqrt(total /
    (n_classes * count)), clipped to cap. Unseen classes get 1.0 (never a
    division by zero); empty input maps every class to 1.0. The caller
    reads train rows only, never dev/calibration.
    """
    counts: dict[str, int] = {}
    total = 0
    for seq in tag_seqs:
        for tag in seq:
            counts[tag] = counts.get(tag, 0) + 1
            total += 1
    weights: dict[str, float] = {}
    n_classes = max(1, len(classes))
    for cls in classes:
        n = counts.get(cls, 0)
        if total <= 0 or n <= 0:
            weights[cls] = 1.0
        else:
            weights[cls] = min(cap, math.sqrt(total / (n_classes * n)))
    return weights


def capture_best_bundle(opt) -> tuple[dict, dict]:
    """Snapshot optimizer+RNG beside best weights (exact-resume bundle).

    Deep-copies the optimizer state so later steps cannot mutate the saved
    bundle; the checkpoint then holds weights, optimizer, RNG, and step
    from the SAME best epoch instead of mixing best weights with latest
    optimizer state.
    """
    return copy.deepcopy(opt.state_dict()), snapshot_rng()


def restore_rng(snap: dict) -> None:
    """Restore RNG states captured by snapshot_rng; ignore missing parts."""
    if not isinstance(snap, dict):
        return
    if "python" in snap:
        try:
            random.setstate(snap["python"])
        except (TypeError, ValueError):
            pass
    if "numpy" in snap:
        try:
            import numpy as np

            np.random.set_state(snap["numpy"])
        except (ImportError, TypeError, ValueError):
            pass
    if "torch" in snap:
        try:
            import torch

            torch.set_rng_state(snap["torch"])
        except (ImportError, TypeError, ValueError, RuntimeError):
            pass


def choose_action_threshold(cal_max: list[float], cal_hit: list[bool],
                            max_wrong_rate: float = 0.05) -> tuple[float, bool]:
    """Choose the lowest safe action threshold, or fail closed.

    The second result reports whether a real operating point was found. A
    threshold above one makes the deployment policy abstain when none exists.
    """
    if len(cal_max) != len(cal_hit) or not cal_max:
        return safe_abstain_threshold(), False
    for cand in [round(x * 0.05, 2) for x in range(1, 20)]:
        wrong = sum(1 for confidence, hit in zip(cal_max, cal_hit)
                    if confidence >= cand and not hit)
        selected = sum(1 for confidence in cal_max if confidence >= cand)
        if selected and wrong / selected <= max_wrong_rate:
            return cand, True
    return safe_abstain_threshold(), False


def bio_tags_for(text: str, spans: list[dict], tokens_meta) -> list[str]:
    """Char-offset spans -> BIO per content token (specials get O)."""
    tokens, _, starts, ends = tokens_meta
    tags = ["O"] * len(tokens)
    for idx, (s, e) in enumerate(zip(starts, ends)):
        if s < 0:
            continue
        hit = None
        for sp in spans:
            if s >= sp["start"] and e <= sp["end"]:
                hit = sp
                break
        if hit is None:
            continue
        first = idx == 0 or not (
            starts[idx - 1] >= hit["start"] and ends[idx - 1] <= hit["end"]
        )
        tags[idx] = ("B-" if first else "I-") + hit["label"]
    return tags


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Train the roles-v1 Jarvis extractor (BERT-Small, 2 CPU, <2.5GiB).")
    ap.add_argument("--data-dir", default="/tmp/opencode/jarvis-extract/data")
    ap.add_argument("--out", default="/tmp/opencode/jarvis-extract/models/extract-v1")
    ap.add_argument("--model-name", default=DEFAULT_MODEL,
                    help="kept 4-layer 512-hidden cached backbone (no generative model)")
    ap.add_argument("--revision", default=DEFAULT_REVISION,
                    help="pinned HF revision (default: cached L-4_H-512 rev)")
    ap.add_argument("--label-schema", default=LABEL_SCHEMA, choices=[LABEL_SCHEMA],
                    help="immutable label schema version (roles-v1 only)")
    ap.add_argument("--local-files-only", action="store_true",
                    help="use the cached HF snapshot only: no remote model_info "
                         "or download; license is read from the cached README")
    ap.add_argument("--force", action="store_true",
                    help="allow overwriting a nonempty out dir (default: refuse)")
    ap.add_argument("--resume", action="store_true",
                    help="explicit in-place resume: reload weights/history (and "
                         "optimizer+RNG when the checkpoint holds them) from "
                         "the out dir and continue its epoch count")
    ap.add_argument("--warm-start", default=None, metavar="CHECKPOINT",
                    help="weights init for a NEW out dir from a stable "
                         "checkpoint.pt (source dir is only read, never "
                         "written); history/optimizer restart unless the "
                         "checkpoint carries them")
    ap.add_argument("--vocab-file", default=None, help="explicit vocab.txt source")
    ap.add_argument("--calib", default=None,
                    help="calibration jsonl (default: <data-dir>/calibration.jsonl)")
    ap.add_argument("--epochs", type=int, default=5)
    ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=96)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--time-budget-s", type=int, default=600)
    ap.add_argument("--warmup-ratio", type=float, default=0.1,
                    help="linear warmup fraction of total steps (round3: fixes early instability)")
    ap.add_argument("--weight-decay", type=float, default=0.01)
    ap.add_argument("--max-grad-norm", type=float, default=1.0)
    ap.add_argument("--early-stop-patience", type=int, default=0,
                    help="stop after this many non-improving epochs (0 disables)")
    ap.add_argument("--early-stop-min-epochs", type=int, default=8,
                    help="minimum completed epochs before early stopping")
    ap.add_argument("--token-threshold", type=float, default=0.35,
                    help="fixed min-span-token operating point (not test-tuned)")
    ap.add_argument("--token-weight", type=float, default=1.0,
                    help="token loss weight; 0.0 = action-only ablation")
    ap.add_argument("--token-class-weight", action="store_true",
                    help="balanced inverse-sqrt-frequency token class weights "
                         "(clipped at 5, counted on train live tags only; "
                         "default off to preserve existing runs)")
    ap.add_argument("--action-class-weight", action="store_true",
                    help="inverse-frequency weights for the action loss "
                    "(closed-class actions have fewer genuine rows)")
    ap.add_argument("--export-only", action="store_true",
                    help="no training: reuse checkpoint/fp32, rewrite sidecars, emit int8")
    ap.add_argument("--checkpoint", default=None,
                    help="checkpoint.pt path (default: <out>/checkpoint.pt)")
    return ap


def check_output_immutable(out: str, force: bool, export_only: bool,
                           resume: bool = False,
                           checkpoint: str | None = None) -> None:
    """Refuse any nonempty out dir (immutable); resume is explicit only."""
    if export_only or force:
        return
    if not os.path.exists(out):
        return
    try:
        entries = os.listdir(out)
    except OSError:
        return
    if not entries:
        return
    if resume:
        ckpt = checkpoint or os.path.join(out, "checkpoint.pt")
        if os.path.exists(ckpt):
            return
        raise SystemExit(
            f"--resume needs an unfinished run with {ckpt}; "
            f"{out} is nonempty without it "
            "(pass --force to overwrite or use a NEW external outdir)")
    raise SystemExit(
        f"refusing to overwrite nonempty {out} ({len(entries)} entries; "
        "avoids clobbering an unfinished run; pass --resume with "
        "checkpoint.pt present or --force, or use a NEW external outdir)")


def make_model(torch_nn, bert_cls, cfg, n_actions: int, n_bio: int):
    import torch
    from torch import nn

    class ExtractModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.bert = bert_cls(config=cfg)
            h = cfg.hidden_size
            self.drop = nn.Dropout(0.1)
            self.action_head = nn.Linear(h, n_actions)
            self.token_head = nn.Linear(h, n_bio)

        def forward(self, input_ids, attention_mask):
            h = self.bert(input_ids=input_ids, attention_mask=attention_mask)[0]
            return self.action_head(self.drop(h[:, 0])), self.token_head(self.drop(h))

    return ExtractModel()


def export_fp32(torch_mod, out_path: str) -> None:
    import torch

    torch_mod.eval()
    dummy_ids = torch.ones(1, 8, dtype=torch.long)
    dummy_mask = torch.ones(1, 8, dtype=torch.long)
    torch.onnx.export(
        torch_mod, (dummy_ids, dummy_mask), out_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["action_logits", "token_logits"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"},
                      "attention_mask": {0: "batch", 1: "seq"},
                      "action_logits": {0: "batch"},
                      "token_logits": {0: "batch", 1: "seq"}},
        opset_version=14, do_constant_folding=True,
    )


def quantize_file(fp32: str, int8: str) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8)


def run_export_only(args) -> None:
    """Recover outputs from the existing stage. No training, no test read."""
    out = args.out
    os.makedirs(out, exist_ok=True)
    ckpt = args.checkpoint or os.path.join(out, "checkpoint.pt")
    fp32 = os.path.join(out, "model_fp32.onnx")
    int8 = os.path.join(out, "model_int8.onnx")
    vocab_txt: str | None = None
    if args.vocab_file:
        with open(args.vocab_file, encoding="utf-8") as f:
            vocab_txt = f.read()
    elif os.path.exists(os.path.join(out, "vocab.txt")):
        with open(os.path.join(out, "vocab.txt"), encoding="utf-8") as f:
            vocab_txt = f.read()

    torch_mod = None
    recovered_actions: list[str] | None = None
    recovered_bio: list[str] | None = None
    recovered_max_len = args.max_len
    recovered_from_checkpoint = False
    if os.path.exists(ckpt):
        import torch
        from transformers import AutoConfig, BertModel

        set_seed(args.seed)
        blob = torch.load(ckpt, map_location="cpu", weights_only=False)
        recovered_from_checkpoint = True
        recovered_actions, recovered_bio, checkpoint_max_len = checkpoint_metadata(blob)
        if checkpoint_max_len is not None:
            recovered_max_len = checkpoint_max_len
        cfg_path = os.path.join(out, "config.json")
        if os.path.exists(cfg_path):
            cfg = AutoConfig.from_pretrained(cfg_path, trust_remote_code=False)
        else:
            if not args.revision:
                raise SystemExit("checkpoint re-export needs --revision for config")
            cfg = AutoConfig.from_pretrained(
                args.model_name, revision=args.revision, trust_remote_code=False)
        from torch import nn  # noqa: F401  (kept for make_model parity)

        if recovered_actions is None:
            recovered_actions = list(ACTIONS)
        if recovered_bio is None:
            sidecar = os.path.join(out, "bio_labels.json")
            if os.path.exists(sidecar):
                with open(sidecar, encoding="utf-8") as f:
                    recovered_bio = json.load(f)
            else:
                recovered_bio = bio_label_list()
        torch_mod = make_model(nn, BertModel, cfg, len(recovered_actions),
                               len(recovered_bio))
        torch_mod.load_state_dict(blob["state_dict"])
        export_fp32(torch_mod, fp32)
        print(f"re-exported fp32 from {ckpt}", flush=True)
        if vocab_txt is None and args.revision:
            snap = resolve_snapshot(
                args.model_name, args.revision,
                bool(getattr(args, "local_files_only", False)))
            with open(os.path.join(snap, "vocab.txt"), encoding="utf-8") as f:
                vocab_txt = f.read()
    else:
        if not os.path.exists(fp32):
            raise SystemExit(
                f"nothing to recover: no {ckpt} and no {fp32}. "
                "Retraining is the only path; pass no --export-only.")
        print(f"reusing existing {fp32} (no checkpoint, no retrain)", flush=True)
        if vocab_txt is None:
            if not args.revision:
                raise SystemExit(
                    "vocab.txt is missing and no --vocab-file/--revision given; "
                    "pass --vocab-file or --revision to restore it.")
            snap = resolve_snapshot(
                args.model_name, args.revision,
                bool(getattr(args, "local_files_only", False)))
            with open(os.path.join(snap, "vocab.txt"), encoding="utf-8") as f:
                vocab_txt = f.read()

    # A fp32-only recovery has no checkpoint metadata. Preserve its sidecars
    # and max length instead of silently switching to the current label set.
    if recovered_actions is None:
        actions_path = os.path.join(out, "actions.json")
        if os.path.exists(actions_path):
            with open(actions_path, encoding="utf-8") as f:
                recovered_actions = json.load(f)
    if recovered_bio is None:
        bio_path = os.path.join(out, "bio_labels.json")
        if os.path.exists(bio_path):
            with open(bio_path, encoding="utf-8") as f:
                recovered_bio = json.load(f)
    thresholds_path = os.path.join(out, "thresholds.json")
    if not recovered_from_checkpoint and os.path.exists(thresholds_path):
        with open(thresholds_path, encoding="utf-8") as f:
            recovered_max_len = int(json.load(f).get("max_len", recovered_max_len))

    # Sidecars before quantization, so a quant failure loses nothing.
    # Preserve each artifact's own label sidecars: old v077 precision
    # files stay inspectable via their PROJECT/... sidecars, new ones via
    # roles-v1. Never force the current label set onto a recovered model.
    id2bio = recovered_bio or bio_label_list()
    actions = recovered_actions or list(ACTIONS)
    assert vocab_txt is not None
    # A checkpoint carries the label ordering used by its heads. When it is
    # available, always restore those sidecars, even if an interrupted export
    # left older sidecars beside the checkpoint.
    restore_sidecars = recovered_from_checkpoint
    label_schema_blob = json.dumps({
        "version": LABEL_SCHEMA
        if set(lab.split("-", 1)[1] for lab in id2bio if lab != "O") == DATA_LABELS
        else "v07-compat",
        "labels": sorted({lab.split("-", 1)[1] for lab in id2bio if lab != "O"}),
        "actions": actions,
    })
    for name, content in (
        ("vocab.txt", vocab_txt),
        ("actions.json", json.dumps(actions)),
        ("bio_labels.json", json.dumps(id2bio)),
        ("label_schema.json", label_schema_blob),
    ):
        p = os.path.join(out, name)
        if restore_sidecars or not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)
    th_path = os.path.join(out, "thresholds.json")
    if not os.path.exists(th_path):
        with open(th_path, "w", encoding="utf-8") as f:
            json.dump({"clarify_threshold": 0.5,
                       "token_threshold": args.token_threshold,
                       "max_len": recovered_max_len,
                       "note": "export-only defaults; calibrate on calibration.jsonl"},
                      f)
    elif recovered_from_checkpoint:
        with open(th_path, encoding="utf-8") as f:
            thresholds = json.load(f)
        if not isinstance(thresholds, dict):
            raise SystemExit(f"invalid thresholds sidecar: {th_path}")
        thresholds["max_len"] = recovered_max_len
        with open(th_path, "w", encoding="utf-8") as f:
            json.dump(thresholds, f)
    quantize_file(fp32, int8)
    print(f"wrote {int8}", flush=True)
    man_path = os.path.join(out, "manifest.json")
    man = {}
    if os.path.exists(man_path):
        with open(man_path, encoding="utf-8") as f:
            man = json.load(f)
    # Audit correction: derive the actual param shape from config instead
    # of trusting the hardcoded label (the v05-big manifest wrongly said
    # 4.4M L-2 for a 29M L-4 model). No model change: metadata only.
    audit_note = None
    try:
        import torch as _torch
        from transformers import AutoConfig as _AutoConfig
        _cfg_path = os.path.join(out, "config.json")
        if os.path.exists(_cfg_path):
            _cfg = _AutoConfig.from_pretrained(_cfg_path, trust_remote_code=False)
            _arch = (f"L={_cfg.num_hidden_layers} H={_cfg.hidden_size} "
                     f"A={_cfg.num_attention_heads}")
            _n = None
            if os.path.exists(ckpt):
                _blob = _torch.load(ckpt, map_location="cpu", weights_only=False)
                _n = sum(p.numel() for p in _blob["state_dict"].values())
            if _n:
                _label = f"~{_n / 1e6:.1f}M ({_arch})"
                if man.get("params") != _label:
                    audit_note = (f"params corrected {man.get('params')!r} "
                                  f"-> {_label!r} (metadata only)")
                    man["params"] = _label
    except Exception as e:  # metadata probe must never break recovery
        audit_note = f"params audit skipped: {type(e).__name__}: {e}"
    man.update({"precision": "fp32 + dynamic-int8",
                "export_only_recovery": True,
                "ort_version": "1.24.4"})
    if audit_note:
        man["audit_note"] = audit_note
        print(audit_note, flush=True)
    with open(man_path, "w", encoding="utf-8") as f:
        json.dump(man, f, indent=2)
    print(json.dumps(man, indent=2))


def main() -> None:
    args = build_parser().parse_args()
    if args.export_only:
        run_export_only(args)
        return
    if not args.revision:
        raise SystemExit("pass --revision with the pinned model commit to reproduce")
    if args.label_schema != LABEL_SCHEMA:
        raise SystemExit(f"unsupported label schema {args.label_schema!r} (roles-v1 only)")
    # Immutable output and row validation run BEFORE any heavy resource
    # launch (torch, transformers, HF download). Uses only stdlib + the
    # pure-python tokenizer side.
    check_output_immutable(
        args.out, args.force, export_only=False,
        resume=bool(getattr(args, "resume", False)),
        checkpoint=args.checkpoint)
    train_rows = read_jsonl(os.path.join(args.data_dir, "train.jsonl"))
    dev_rows = read_jsonl(os.path.join(args.data_dir, "dev.jsonl"))
    calib_path = args.calib or os.path.join(args.data_dir, "calibration.jsonl")
    if not os.path.exists(calib_path):
        raise SystemExit(
            f"calibration data is required: missing {calib_path}; "
            "refusing to tune policy on dev")
    calib_rows = read_jsonl(calib_path)
    if not calib_rows:
        raise SystemExit(f"calibration data is empty: {calib_path}")
    if not train_rows or not dev_rows:
        raise SystemExit("train/dev splits must be non-empty")
    calib_name = calib_path
    for r in train_rows:
        validate_row(r, expected_split="train")
    for r in dev_rows:
        validate_row(r, expected_split="dev")
    for r in calib_rows:
        validate_row(r, expected_split="calibration")
    print(f"validated {len(train_rows)} train / {len(dev_rows)} dev / "
          f"{len(calib_rows)} calib rows (roles-v1, codepoint offsets)",
          flush=True)

    t0 = time.time()
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    set_seed(args.seed)

    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset
    from transformers import AutoConfig, BertModel

    local_only = bool(getattr(args, "local_files_only", False))
    if local_only:
        # Cached-only: no remote model_info call. License comes from the
        # pinned snapshot's cached README; trust checks stay intact.
        snap = resolve_snapshot(args.model_name, args.revision, True)
        lic = read_cached_license(snap)
        if lic not in APACHE_LICENSES:
            raise SystemExit(
                f"license check failed for cached {args.model_name}@{args.revision}: "
                f"{lic!r} (expected Apache-2.0 in cached README)")
        print(f"local-files-only: snapshot {snap} license {lic}", flush=True)
    else:
        from huggingface_hub import model_info as hf_model_info

        info = hf_model_info(args.model_name, revision=args.revision)
        lic = ((info.cardData.get("license") if info.cardData else None)
               or getattr(info, "license", None))
        if lic not in APACHE_LICENSES:
            raise SystemExit(f"license check failed for {args.model_name}: {lic!r}")
        snap = resolve_snapshot(args.model_name, args.revision, False)
    vocab_src = args.vocab_file or os.path.join(snap, "vocab.txt")
    with open(vocab_src, encoding="utf-8") as f:
        vocab = {line.rstrip("\n"): i for i, line in enumerate(f)}
    # max_len 96 overflow is a startup failure, never silent truncation:
    # every train/dev/calib row must fit CLS + content + SEP.
    check_no_overflow(train_rows + dev_rows + calib_rows, vocab, args.max_len)
    print(f"overflow check passed: all rows fit max_len={args.max_len}", flush=True)

    id2bio = bio_label_list()
    bio2id = {t: i for i, t in enumerate(id2bio)}
    act2id = {a: i for i, a in enumerate(ACTIONS)}

    def encode(rows):
        ids, masks, atags, ttags = [], [], [], []
        for r in rows:
            tokens, t_ids, starts, ends = tokenize_with_offsets(
                r["text"], vocab, args.max_len
            )
            tags = bio_tags_for(r["text"], r.get("spans", []), (tokens, t_ids, starts, ends))
            mask = [0 if t == "[PAD]" else 1 for t in tokens]
            ids.append(t_ids)
            masks.append(mask)
            atags.append(act2id[r["action"]])
            # PAD positions carry IGNORE so O-heavy padding never dominates loss.
            ttags.append([bio2id[t] if m else IGNORE for t, m in zip(tags, mask)])
        return (
            torch.tensor(ids, dtype=torch.long),
            torch.tensor(masks, dtype=torch.long),
            torch.tensor(atags, dtype=torch.long),
            torch.tensor(ttags, dtype=torch.long),
        )

    tr = encode(train_rows)
    dv = encode(dev_rows)
    loader = DataLoader(
        TensorDataset(*tr), batch_size=args.batch, shuffle=True, num_workers=0
    )

    cfg = AutoConfig.from_pretrained(args.model_name, revision=args.revision,
                                     trust_remote_code=False)
    base = BertModel.from_pretrained(
        args.model_name, revision=args.revision, config=cfg, trust_remote_code=False)
    model = make_model(nn, BertModel, cfg, len(ACTIONS), len(id2bio))
    _load_res = model.bert.load_state_dict(base.state_dict(), strict=False)
    # Spec: record pretrained missing/unexpected keys (backbone vs head).
    missing_keys = list(getattr(_load_res, "missing_keys", []))
    unexpected_keys = list(getattr(_load_res, "unexpected_keys", []))
    print(f"pretrained load: missing={len(missing_keys)} "
          f"unexpected={len(unexpected_keys)}", flush=True)
    for k in (missing_keys + unexpected_keys)[:20]:
        print(f"  key: {k}", flush=True)
    device = torch.device("cpu")
    model.to(device)
    os.makedirs(args.out, exist_ok=True)
    ckpt_path = args.checkpoint or os.path.join(args.out, "checkpoint.pt")
    config_path = os.path.join(args.out, "config.json")
    history_path = os.path.join(args.out, "history.jsonl")
    cfg.to_json_file(config_path)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr,
                            weight_decay=args.weight_decay)
    # Round3: linear warmup + linear decay. The v0.1.0 run used a flat LR
    # with no warmup; on 2-thread CPU with a 2-layer encoder the first
    # steps overshoot and dev loss stalls. Warmup costs nothing and is
    # required before any overfit diagnostic can pass.
    # Placeholder; recomputed over the planned total (prior + new epochs)
    # after the restart block below, before the epoch loop.
    total_steps = max(1, len(loader) * args.epochs)
    warmup_steps = int(total_steps * args.warmup_ratio)
    def _lr_at(step: int) -> float:
        if warmup_steps > 0 and step < warmup_steps:
            return args.lr * (step + 1) / max(1, warmup_steps)
        denom = max(1, total_steps - warmup_steps)
        prog = min(1.0, max(0.0, (step - warmup_steps) / denom))
        return args.lr * (1.0 - prog)
    if args.action_class_weight:
        from collections import Counter
        _freq = Counter(act2id[r["action"]] for r in train_rows)
        _total = len(train_rows)
        _w = [_total / (len(act2id) * _freq.get(i, 1)) for i in range(len(act2id))]
        loss_act = nn.CrossEntropyLoss(weight=torch.tensor(_w, dtype=torch.float))
        print(f"action class weights: {[round(x, 2) for x in _w]}",
              flush=True)
    else:
        loss_act = nn.CrossEntropyLoss()
    if args.token_class_weight:
        # Counted on train live tags only (PAD/IGNORE excluded); dev and
        # calibration rows are never read for weights.
        train_live_tags = []
        for r in train_rows:
            toks, _, ss, ee = tokenize_with_offsets(r["text"], vocab, args.max_len)
            tags = bio_tags_for(r["text"], r.get("spans", []), (toks, None, ss, ee))
            train_live_tags.append(
                [t for t, tok in zip(tags, toks) if tok != "[PAD]"])
        tok_map = token_class_weights(train_live_tags, id2bio)
        tok_w = torch.tensor([tok_map[t] for t in id2bio], dtype=torch.float)
        loss_tok = nn.CrossEntropyLoss(weight=tok_w, ignore_index=IGNORE)
        print(f"token class weights: {json.dumps(tok_map, sort_keys=True)}",
              flush=True)
    else:
        loss_tok = nn.CrossEntropyLoss(ignore_index=IGNORE)
    if args.token_weight != 1.0:
        print(f"token loss weight {args.token_weight} (ablation)", flush=True)

    def split_metrics(ids_t, mask_t, act_t, tok_t, n_rows):
        model.eval()
        tot = tot_a = tot_t = 0.0
        tot_act_ok = tot_tok_ok = tot_tok = tot_act = tot_strict = 0
        n = 0
        act_confs: list[float] = []
        with torch.no_grad():
            for i in range(0, n_rows, args.batch):
                sl = slice(i, i + args.batch)
                b_ids, b_mask = ids_t[sl].to(device), mask_t[sl].to(device)
                b_act, b_tok = act_t[sl].to(device), tok_t[sl].to(device)
                a_l, t_l = model(b_ids, b_mask)
                la = float(loss_act(a_l, b_act).item())
                lt = float(loss_tok(t_l.view(-1, len(id2bio)),
                                    b_tok.view(-1)).item())
                tot_a += la * len(b_act)
                tot_t += lt * len(b_act)
                tot += (la + lt) * len(b_act)
                probs = torch.softmax(a_l, dim=-1).cpu()
                ap = a_l.argmax(-1).cpu()
                tp = t_l.argmax(-1).cpu()
                for j in range(ap.numel()):
                    tot_act += 1
                    n += 1
                    if int(ap[j]) == int(act_t[i + j]):
                        tot_act_ok += 1
                    act_confs.append(float(probs[j][int(ap[j])]))
                    live = (tok_t[i + j] != IGNORE)
                    tot_tok += int(live.sum())
                    tot_tok_ok += int(((tp[j] == tok_t[i + j]) & live).sum())
                    if (int(ap[j]) == int(act_t[i + j])
                            and bool((tp[j][live] == tok_t[i + j][live]).all())):
                        tot_strict += 1
        import statistics
        act_confs.sort()
        def pct(q: float) -> float:
            return round(act_confs[min(len(act_confs) - 1,
                                       int(q * len(act_confs)))] if act_confs else 0.0, 4)
        return {"loss": weighted_selection_loss(
                    tot_a / max(n, 1), tot_t / max(n, 1), args.token_weight),
                "action_loss": tot_a / max(n, 1),
                "token_loss": tot_t / max(n, 1),
                "action_acc": tot_act_ok / max(tot_act, 1),
                "token_acc": tot_tok_ok / max(tot_tok, 1),
                "strict": tot_strict / max(n, 1),
                "conf_p50": pct(0.5), "conf_p90": pct(0.9),
                "conf_mean": round(sum(act_confs) / max(len(act_confs), 1), 4)}

    def dev_metrics():
        return split_metrics(dv[0], dv[1], dv[2], dv[3], len(dev_rows))

    def train_metrics():
        return split_metrics(tr[0], tr[1], tr[2], tr[3], len(train_rows))

    # Best by dev LOSS (min). Strict whole-example stays logged for continuity
    # but never selects: at 0.000 across epochs it ties and would retain epoch 0.
    best_loss, best_state, best_met = float("inf"), None, None
    best_ep = -1
    global_step = 0
    history: list[dict] = []
    stale_epochs = 0
    stop_reason: str | None = None
    start_epoch = 0
    resume_kind = "fresh"
    resume_source: str | None = None
    # Best-epoch companions: optimizer/RNG/step captured AT the best epoch,
    # so the checkpoint bundle is always self-consistent (best weights with
    # best-epoch optimizer state, never best weights with latest state).
    best_opt_state = None
    best_rng = None
    best_global_step = 0

    if args.resume and getattr(args, "warm_start", None):
        raise SystemExit("pass only one of --resume (same dir) or --warm-start (new dir)")
    if args.resume:
        resume_source = args.checkpoint or os.path.join(args.out, "checkpoint.pt")
    elif getattr(args, "warm_start", None):
        resume_source = args.warm_start
    if resume_source is not None:
        # Genuine restart: weights are verified inside the model BEFORE any
        # optimizer step. --resume continues the same dir (history reloaded);
        # --warm-start seeds a NEW dir (source dir is only read).
        if not os.path.exists(resume_source):
            raise SystemExit(f"restart source missing: {resume_source}")
        blob = torch.load(resume_source, map_location="cpu", weights_only=False)
        verify_checkpoint_compat(blob, model=args.model_name,
                                 revision=args.revision,
                                 actions=list(ACTIONS), bio_labels=id2bio,
                                 max_len=args.max_len)
        strict_load_state_dict(model, blob["state_dict"])
        print("restart weights verified inside model before any step "
              "(missing=0 unexpected=0)", flush=True)
        resume_kind = resume_mode(blob)
        if args.resume and os.path.exists(history_path):
            with open(history_path, encoding="utf-8") as hf:
                history = [json.loads(ln) for ln in hf if ln.strip()]
        hist_ep, hist_loss, hist_step = resume_init_from_history(history)
        best_ep = hist_ep if hist_ep >= 0 else int(blob.get("best_epoch", -1))
        best_loss = hist_loss if hist_loss is not None else float("inf")
        best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
        start_epoch = int(blob.get("epochs_run", len(history)))
        try:
            global_step = int(blob.get("global_step", hist_step)
                              or hist_step or start_epoch * len(loader))
        except (TypeError, ValueError):
            global_step = start_epoch * len(loader)
        best_global_step = global_step
        if isinstance(blob.get("optimizer"), dict):
            try:
                opt.load_state_dict(blob["optimizer"])
                # Deep-copy: the live optimizer must never alias the saved
                # bundle, or later steps would corrupt the best snapshot.
                best_opt_state = copy.deepcopy(blob["optimizer"])
                opt_note = "optimizer restored"
            except (ValueError, RuntimeError, KeyError) as e:
                best_opt_state = None
                opt_note = (f"optimizer NOT restored ({type(e).__name__}); "
                            f"fresh optimizer")
        else:
            opt_note = ("fresh optimizer (checkpoint predates optimizer "
                        "snapshots); weights-only warm restart, not an exact resume")
        if isinstance(blob.get("rng"), dict):
            restore_rng(blob["rng"])
            best_rng = blob["rng"]
            rng_note = "RNG restored (batch order best-effort, not bit-exact)"
        else:
            rng_note = "RNG fresh from --seed (batch order may differ; not bit-exact)"
        print(f"restart from {resume_source}: mode={resume_kind} "
              f"start_epoch={start_epoch} global_step={global_step} "
              f"best_ep={best_ep} "
              f"best_loss={(None if best_loss == float('inf') else round(best_loss, 4))}; "
              f"{opt_note}; {rng_note}", flush=True)

    def save_best_checkpoint(training_complete: bool) -> None:
        # The bundle is always best-epoch-consistent: best weights ship
        # with the optimizer/RNG/step captured at that same epoch, never
        # with latest state. A weights-only restart with no new improvement
        # re-saves weights-only (honest mode); a fresh run with no
        # improvement yet saves current state (trivially consistent).
        if best_state is not None and best_opt_state is not None:
            state, saved_opt, saved_rng, saved_step = (
                best_state, best_opt_state, best_rng, best_global_step)
        elif best_state is not None:
            state, saved_opt, saved_rng, saved_step = (
                best_state, None, None, best_global_step)
        else:
            state = {k: value.cpu().clone()
                     for k, value in model.state_dict().items()}
            saved_opt, saved_rng, saved_step = (
                opt.state_dict(), snapshot_rng(), global_step)
        torch.save({
            "state_dict": state,
            "model": args.model_name,
            "revision": args.revision,
            "actions": list(ACTIONS),
            "bio_labels": id2bio,
            "max_len": args.max_len,
            "seed": args.seed,
            "best_epoch": best_ep,
            "epochs_run": len(history),
            "training_complete": training_complete,
            "global_step": saved_step,
            "best_loss": best_loss if best_loss != float("inf") else None,
            "optimizer": saved_opt,
            "rng": saved_rng,
        }, ckpt_path)

    def save_history() -> None:
        with open(history_path, "w", encoding="utf-8") as history_file:
            for row in history:
                history_file.write(json.dumps(row) + "\n")

    # The LR schedule spans the planned total (prior epochs + this run's
    # --epochs), so a restart continues the decay instead of rewarming.
    planned_total_epochs = start_epoch + args.epochs
    total_steps = max(1, len(loader) * planned_total_epochs)
    warmup_steps = int(total_steps * args.warmup_ratio)

    for ep in range(start_epoch, planned_total_epochs):
        if time.time() - t0 > args.time_budget_s - 60:
            stop_reason = "time-budget-before-epoch"
            print(f"time budget: stopping before epoch {ep}", flush=True)
            break
        model.train()
        for b_ids, b_mask, b_act, b_tok in loader:
            for pg in opt.param_groups:
                pg["lr"] = _lr_at(global_step)
            b_ids, b_mask, b_act, b_tok = (
                b_ids.to(device), b_mask.to(device), b_act.to(device), b_tok.to(device))
            opt.zero_grad()
            a_logits, t_logits = model(b_ids, b_mask)
            loss = loss_act(a_logits, b_act) + args.token_weight * loss_tok(
                t_logits.view(-1, len(id2bio)), b_tok.view(-1))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
            opt.step()
            global_step += 1
        lr_now = opt.param_groups[0]["lr"]
        tm = train_metrics()
        m = dev_metrics()
        print(f"epoch {ep}: lr {lr_now:.2e} "
              f"train loss {tm['loss']:.4f} (a {tm['action_loss']:.4f} "
              f"t {tm['token_loss']:.4f}) acc {tm['action_acc']:.3f}/"
              f"{tm['token_acc']:.3f}/{tm['strict']:.3f} | dev loss {m['loss']:.4f} "
              f"(a {m['action_loss']:.4f} t {m['token_loss']:.4f}) acc "
              f"{m['action_acc']:.3f}/{m['token_acc']:.3f}/{m['strict']:.3f} "
              f"conf mean {m['conf_mean']:.3f} p50 {m['conf_p50']:.3f} "
              f"p90 {m['conf_p90']:.3f}", flush=True)
        history.append({"epoch": ep, "lr": lr_now, "global_step": global_step,
                        "train": tm, "dev": m})
        save_history()
        if m["loss"] < best_loss:
            best_loss, best_state, best_met = m["loss"], \
                {k: v.cpu().clone() for k, v in model.state_dict().items()}, m
            best_ep = ep
            # Companion snapshot AT the best epoch: keeps the checkpoint
            # bundle self-consistent for future exact resumes.
            best_opt_state, best_rng = capture_best_bundle(opt)
            best_global_step = global_step
            save_best_checkpoint(training_complete=False)
            stale_epochs = 0
        else:
            stale_epochs += 1
        if (args.early_stop_patience > 0
                and ep + 1 >= args.early_stop_min_epochs
                and stale_epochs >= args.early_stop_patience):
            stop_reason = "early-stop"
            print(f"early stopping after epoch {ep}: "
                  f"{stale_epochs} epochs without dev improvement", flush=True)
            break
    if stop_reason is None:
        stop_reason = "epoch-limit"
    if best_state is not None:
        model.load_state_dict(best_state)

    # Checkpoint FIRST so a later export/quant failure never forces retraining.
    save_best_checkpoint(training_complete=stop_reason != "time-budget-before-epoch")
    cfg.to_json_file(config_path)

    # Sidecars BEFORE export/quant for the same reason.
    with open(os.path.join(snap, "vocab.txt"), encoding="utf-8") as f:
        vocab_txt = f.read()
    with open(os.path.join(args.out, "vocab.txt"), "w", encoding="utf-8") as f:
        f.write(vocab_txt)
    with open(os.path.join(args.out, "actions.json"), "w", encoding="utf-8") as f:
        json.dump(list(ACTIONS), f)
    with open(os.path.join(args.out, "bio_labels.json"), "w", encoding="utf-8") as f:
        json.dump(id2bio, f)
    with open(os.path.join(args.out, "label_schema.json"), "w", encoding="utf-8") as f:
        json.dump({"version": LABEL_SCHEMA, "labels": list(LABELS),
                   "actions": list(ACTIONS)}, f)

    # Record an action-only calibration on CALIBRATION only (never test).
    # This is NOT a readiness signal: joint complete-frame int8 policy is
    # a separate step in calibrate.py (action + span confidence). Precision
    # is conserved (fp32 + dynamic-int8); thresholds here gate the eval
    # harness only.
    model.eval()
    cb = encode(calib_rows)
    cal_max, cal_hit = [], []
    with torch.no_grad():
        for i in range(0, len(calib_rows), args.batch):
            sl = slice(i, i + args.batch)
            a_l, _ = model(cb[0][sl].to(device), cb[1][sl].to(device))
            probs = torch.softmax(a_l, dim=-1).cpu()
            for j in range(probs.numel() // len(ACTIONS)):
                p = probs[j]
                best = int(p.argmax())
                cal_max.append(float(p[best]))
                cal_hit.append(best == int(cb[2][i + j]))
    thresh, calib_valid = choose_action_threshold(cal_max, cal_hit)
    if not calib_valid:
        print("calibration found no safe action operating point; "
              "policy threshold is fail-closed", flush=True)
    with open(os.path.join(args.out, "thresholds.json"), "w", encoding="utf-8") as f:
        json.dump({"clarify_threshold": thresh, "token_threshold": args.token_threshold,
                   "max_len": args.max_len, "calibrated_on": calib_name,
                   "calibration_valid": calib_valid,
                   "calibration_mode": "action-confidence-only",
                   "readiness": False,
                   "note": "action-only; run calibrate.py for joint complete-frame "
                           "readiness policy (action + span confidence)"}, f)

    export_fp32(model, os.path.join(args.out, "model_fp32.onnx"))
    quantize_file(os.path.join(args.out, "model_fp32.onnx"),
                  os.path.join(args.out, "model_int8.onnx"))

    # Independent fp32 ONNX logit parity (not quant): torch vs ORT fp32 on
    # a fixed dev sample. Quant drift is measured separately by evaluate.py.
    # The exported candidate is not valid without this check.
    parity_path = os.path.join(args.out, "export-parity.json")
    parity_tolerance = 1e-3
    onnx_parity: dict = {"checked": False}
    try:
        import numpy as _np
        import onnxruntime as _ort

        _so = _ort.SessionOptions()
        _so.intra_op_num_threads = 2
        _so.inter_op_num_threads = 1
        _sess = _ort.InferenceSession(
            os.path.join(args.out, "model_fp32.onnx"), sess_options=_so)
        _n = min(8, len(dev_rows))
        _max_a = _max_t = 0.0
        model.eval()
        with torch.no_grad():
            for i in range(_n):
                _ids = dv[0][i:i + 1].numpy()
                _mask = dv[1][i:i + 1].numpy()
                ta, tt = model(torch.tensor(_ids), torch.tensor(_mask))
                outs = _sess.run(None, {"input_ids": _ids.astype(_np.int64),
                                        "attention_mask": _mask.astype(_np.int64)})
                by = dict(zip([o.name for o in _sess.get_outputs()], outs))
                oa, ot = by.get("action_logits"), by.get("token_logits")
                if oa is None:
                    oa, ot = (outs[0], outs[1]) if outs[1].ndim == 3 else (outs[1], outs[0])
                _max_a = max(_max_a, float(abs(ta.numpy() - oa).max()))
                _max_t = max(_max_t, float(abs(tt.numpy() - ot).max()))
        onnx_parity = {"checked": True, "n": _n,
                       "max_abs_action_logit_diff": _max_a,
                       "max_abs_token_logit_diff": _max_t}
        print(f"onnx parity fp32 n={_n} max_a={_max_a:.2e} max_t={_max_t:.2e}",
              flush=True)
    except Exception as e:  # record evidence before failing the export
        onnx_parity = {"checked": False, "error": f"{type(e).__name__}: {e}"}
        print(f"onnx parity probe failed: {onnx_parity['error']}", flush=True)

    with open(parity_path, "w", encoding="utf-8") as f:
        json.dump({**onnx_parity, "tolerance": parity_tolerance}, f, indent=2)
    if (
        not onnx_parity.get("checked")
        or int(onnx_parity.get("n", 0)) <= 0
        or not math.isfinite(float(onnx_parity.get("max_abs_action_logit_diff", math.inf)))
        or not math.isfinite(float(onnx_parity.get("max_abs_token_logit_diff", math.inf)))
        or float(onnx_parity.get("max_abs_action_logit_diff", math.inf)) > parity_tolerance
        or float(onnx_parity.get("max_abs_token_logit_diff", math.inf)) > parity_tolerance
    ):
        raise SystemExit(
            "fp32 ONNX export parity failed; checkpoint and parity evidence "
            f"preserved at {parity_path}"
        )

    save_history()

    data_hash = hashlib.sha256(
        ("".join(sorted(r["id"] for r in train_rows + dev_rows + calib_rows))).encode()
    ).hexdigest()[:16]
    arch = (f"L={cfg.num_hidden_layers} H={cfg.hidden_size} "
            f"A={cfg.num_attention_heads}")
    n_params = sum(p.numel() for p in model.parameters())
    manifest = {
        "model": args.model_name, "revision": args.revision, "license": lic,
        "source": f"https://huggingface.co/{args.model_name}",
        "params": f"~{n_params / 1e6:.1f}M ({arch})", "finetune": "head+backbone",
        "label_schema": LABEL_SCHEMA, "labels": list(LABELS),
        "actions": list(ACTIONS),
        "seed": args.seed, "threads": 2, "precision": "fp32 + dynamic-int8",
        "onnx_opset": 14, "ort_version": "1.24.4",
        "dev_loss": best_met["loss"] if best_met else None,
        "dev_action_acc": best_met["action_acc"] if best_met else None,
        "dev_token_acc": best_met["token_acc"] if best_met else None,
        "dev_strict": best_met["strict"] if best_met else None,
        "dev_action_loss": best_met.get("action_loss") if best_met else None,
        "dev_token_loss": best_met.get("token_loss") if best_met else None,
        "best_epoch": best_ep,
        "epochs_run": len(history),
        "training_complete": stop_reason != "time-budget-before-epoch",
        "stop_reason": stop_reason,
        "restart_mode": resume_kind,
        "restart_source": resume_source,
        "start_epoch": start_epoch,
        "planned_total_epochs": planned_total_epochs,
        "missing_keys": missing_keys,
        "unexpected_keys": unexpected_keys,
        "onnx_parity_fp32": onnx_parity,
        "clarify_threshold_calib": thresh, "calibration_valid": calib_valid,
        "calibration_mode": "action-confidence-only",
        "readiness": False,
        "calibrated_on": calib_name,
        "checkpoint": os.path.basename(ckpt_path),
        "data_ids_sha16": data_hash, "time_s": round(time.time() - t0, 1),
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
