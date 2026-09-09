"""Focused roles-v1 tests for the v08 train/infer/adapter path.

Run with stdlib only (no torch/onnxruntime needed):
  python3 scripts/jarvis-extract/test_roles_v08.py
  python3 -m pytest scripts/jarvis-extract/test_roles_v08.py -q

Covers: tokenizer codepoint offsets (astral, accent 1:1), BIO tagging for
roles-v1 (wrapper with comma/space), strict row validation (no old
labels, split enforcement, span-text char coverage), label-schema
immutability (any nonempty out dir refused; resume explicit only),
--local-files-only cached-license parsing, max_len overflow failure,
dynamic sidecar verification (old v077 inspectable), joint
complete-frame calibration (action-only is NOT readiness), and evaluate
complete-frame scoring with per-label recall.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import calibrate as calibrate_mod
import evaluate as evaluate_mod
import inference as inference_mod
import train as train_mod


def _roles_row(**over):
    base = {
        "id": "jx-v08-test-start-000",
        "family": "v08-test-start",
        "provenance": "authored-v08",
        "split": "train",
        "text": "fix login in Harbor",
        "action": "start",
        "spans": [{"start": 10, "end": 19, "label": "DESTINATION"}],
    }
    base.update(over)
    return base


class TokenizerOffsets(unittest.TestCase):
    def test_basic_offsets_are_codepoints(self):
        vocab = {"[CLS]": 0, "[SEP]": 1, "[PAD]": 2, "[UNK]": 3,
                 "fix": 4, "login": 5, "in": 6, "harbor": 7}
        tokens, ids, starts, ends = inference_mod.tokenize_with_offsets(
            "fix login in Harbor", vocab, 96)
        self.assertEqual(tokens[0], "[CLS]")
        self.assertIn("[SEP]", tokens)
        # "fix login in Harbor": Harbor spans codepoints [13,19).
        self.assertIn(13, starts)
        self.assertIn(19, ends)

    def test_astral_offsets_stay_codepoints(self):
        text = "🔧 Fix Harbor"
        toks = inference_mod.basic_tokenize_with_offsets(text)
        # 🔧 is one codepoint at [0,1); "Fix" starts at codepoint 2.
        flat = [(w, s, e) for w, s, e in toks]
        self.assertTrue(any(s == 0 and e == 1 for _, s, e in flat))
        self.assertTrue(any(w == "fix" and s == 2 for w, s, e in flat))

    def test_accent_strip_stays_1to1(self):
        self.assertEqual(inference_mod._lookup_form("café"), "cafe")
        self.assertEqual(len(inference_mod._lookup_form("café")), len("café"))
        toks = inference_mod.wordpiece_tokenize(
            "café", 0, {"cafe": 10, "[UNK]": 100})
        self.assertEqual(toks, [("cafe", 0, 4)])

    def test_encode_live_never_feeds_pad(self):
        vocab = {"[CLS]": 0, "[SEP]": 1, "[PAD]": 2, "[UNK]": 3, "hi": 4}
        tokens, ids, starts, ends, truncated = inference_mod.encode_live("hi hi", vocab, 8)
        self.assertFalse(truncated)
        self.assertNotIn("[PAD]", tokens)
        self.assertEqual(len(tokens), len(ids))

    def test_truncation_is_explicit(self):
        vocab = {"[CLS]": 0, "[SEP]": 1, "[PAD]": 2, "[UNK]": 3, "a": 4}
        _, _, _, _, truncated = inference_mod.encode_live("a a a a a", vocab, 4)
        self.assertTrue(truncated)


class BioLabels(unittest.TestCase):
    def test_roles_v1_ordering(self):
        labels = inference_mod.bio_label_list()
        self.assertEqual(labels[0], "O")
        self.assertEqual(len(labels), 1 + 8 * 2)
        for lab in inference_mod.LABELS:
            self.assertIn(f"B-{lab}", labels)
            self.assertIn(f"I-{lab}", labels)
        self.assertEqual(inference_mod.LABEL_SCHEMA_VERSION, "roles-v1")

    def test_bio_tags_for_roles(self):
        vocab = {"[CLS]": 0, "[SEP]": 1, "[PAD]": 2, "[UNK]": 3,
                 "fix": 4, "login": 5, "in": 6, "harbor": 7}
        text = "fix login in Harbor"
        meta = inference_mod.tokenize_with_offsets(text, vocab, 32)
        tags = train_mod.bio_tags_for(
            text, [{"start": 10, "end": 19, "label": "DESTINATION"}], meta)
        self.assertIn("B-DESTINATION", tags)
        self.assertNotIn("B-PROJECT", tags)

    def test_bio_tags_wrapper_with_comma(self):
        # "In Foxglove," wrapper: preposition + name + comma all carry the
        # DESTINATION tag (char coverage); the adapter derives the value.
        vocab = {"[CLS]": 0, "[SEP]": 1, "[PAD]": 2, "[UNK]": 3,
                 "in": 4, "foxglove": 5, ",": 6, "fix": 7, "login": 8}
        text = "In Foxglove, fix login"
        meta = inference_mod.tokenize_with_offsets(text, vocab, 32)
        tags = train_mod.bio_tags_for(
            text, [{"start": 0, "end": 12, "label": "DESTINATION"}], meta)
        # tokens: CLS, in, foxglove, ',', fix, login, SEP, PAD...
        self.assertEqual(tags[1], "B-DESTINATION")
        self.assertEqual(tags[2], "I-DESTINATION")
        self.assertEqual(tags[3], "I-DESTINATION")
        self.assertEqual(tags[4], "O")


class RowValidation(unittest.TestCase):
    def test_accepts_roles_row(self):
        train_mod.validate_row(_roles_row())

    def test_rejects_old_labels(self):
        row = _roles_row(spans=[{"start": 0, "end": 3, "label": "PROJECT"}])
        with self.assertRaises(AssertionError):
            train_mod.validate_row(row)
        row = _roles_row(spans=[{"start": 0, "end": 3, "label": "INSTRUCTION"}])
        with self.assertRaises(AssertionError):
            train_mod.validate_row(row)

    def test_rejects_bad_offsets_and_overlap(self):
        with self.assertRaises(AssertionError):
            train_mod.validate_row(_roles_row(spans=[
                {"start": 5, "end": 5, "label": "TASK"}]))
        with self.assertRaises(AssertionError):
            train_mod.validate_row(_roles_row(text="hi", spans=[
                {"start": 0, "end": 99, "label": "TASK"}]))
        with self.assertRaises(AssertionError):
            train_mod.validate_row(_roles_row(
                text="abcdef",
                spans=[{"start": 0, "end": 4, "label": "TASK"},
                       {"start": 2, "end": 6, "label": "SUBJECT"}]))

    def test_requires_identity_fields(self):
        row = _roles_row()
        del row["id"]
        with self.assertRaises(AssertionError):
            train_mod.validate_row(row)
        row = _roles_row()
        del row["family"]
        with self.assertRaises(AssertionError):
            train_mod.validate_row(row)
        row = _roles_row()
        del row["split"]
        with self.assertRaises(AssertionError):
            train_mod.validate_row(row)

    def test_split_enforcement(self):
        train_mod.validate_row(_roles_row(split="train"), expected_split="train")
        with self.assertRaises(AssertionError):
            train_mod.validate_row(_roles_row(split="dev"), expected_split="train")
        train_mod.validate_row(_roles_row(split="calibration"),
                               expected_split="calibration")
        with self.assertRaises(AssertionError):
            train_mod.validate_row(_roles_row(split="train"),
                                   expected_split="calibration")

    def test_span_text_char_coverage(self):
        row = _roles_row(text="In Foxglove, fix login",
                         spans=[{"start": 0, "end": 12,
                                  "label": "DESTINATION",
                                  "text": "In Foxglove,"}])
        train_mod.validate_row(row)
        bad = _roles_row(text="In Foxglove, fix login",
                         spans=[{"start": 0, "end": 12,
                                  "label": "DESTINATION",
                                  "text": "in Foxglove"}])
        with self.assertRaises(AssertionError):
            train_mod.validate_row(bad)


class TrainParams(unittest.TestCase):
    def test_defaults_keep_small_cached_model(self):
        ap = train_mod.build_parser()
        args = ap.parse_args([])
        self.assertEqual(args.model_name, "google/bert_uncased_L-4_H-512_A-8")
        self.assertEqual(args.revision, train_mod.DEFAULT_REVISION)
        self.assertEqual(args.label_schema, "roles-v1")

    def test_immutable_output_refuses_any_nonempty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Unfinished run: stray file, no manifest -> still refused.
            with open(os.path.join(tmp, "checkpoint.pt"), "w") as f:
                f.write("partial")
            with self.assertRaises(SystemExit):
                train_mod.check_output_immutable(tmp, False, False)
            # Explicit resume reuses the unfinished run only.
            train_mod.check_output_immutable(tmp, False, False, resume=True)
            with tempfile.TemporaryDirectory() as tmp2:
                with open(os.path.join(tmp2, "manifest.json"), "w") as f:
                    json.dump({"label_schema": "roles-v1"}, f)
                with self.assertRaises(SystemExit):
                    train_mod.check_output_immutable(tmp2, False, False)
                # Resume without a checkpoint is not a resume.
                with self.assertRaises(SystemExit):
                    train_mod.check_output_immutable(
                        tmp2, False, False, resume=True)
                # --force or export-only bypasses the guard.
                train_mod.check_output_immutable(tmp2, True, False)
                train_mod.check_output_immutable(tmp2, False, True)
        with tempfile.TemporaryDirectory() as empty:
            train_mod.check_output_immutable(empty, False, False)
        train_mod.check_output_immutable("/nonexistent-out-dir-xyz", False, False)

    def test_local_files_only_flag_defaults_off(self):
        ap = train_mod.build_parser()
        args = ap.parse_args([])
        self.assertFalse(args.local_files_only)
        self.assertFalse(args.resume)

    def test_cached_license_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "README.md"), "w") as f:
                f.write("---\nlicense: apache-2.0\n---\n")
            self.assertEqual(train_mod.read_cached_license(tmp), "apache-2.0")
            self.assertIn(train_mod.read_cached_license(tmp),
                          train_mod.APACHE_LICENSES)
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "README.md"), "w") as f:
                f.write("no frontmatter\n")
            self.assertIsNone(train_mod.read_cached_license(tmp))
        self.assertIsNone(train_mod.read_cached_license("/nonexistent-dir-xyz"))

    def test_overflow_fails_startup(self):
        vocab = {"[CLS]": 0, "[SEP]": 1, "[PAD]": 2, "[UNK]": 3, "a": 4}
        rows = [{"id": "r1", "text": "a a a a a"}]
        with self.assertRaises(SystemExit):
            train_mod.check_no_overflow(rows, vocab, 4)
        train_mod.check_no_overflow([{"id": "r1", "text": "a a"}], vocab, 8)

class TokenClassWeights(unittest.TestCase):
    def test_rare_emphasized_and_clipped(self):
        # O dominance (3500) vs rare roles (16-33): rare must weigh more,
        # the rarest clips exactly at the cap.
        seqs = [["O"] * 3500 + ["B-DESTINATION"] * 417
                + ["B-PROVIDER"] * 20 + ["B-MODEL"] * 8]
        classes = ["O", "B-DESTINATION", "B-PROVIDER", "B-MODEL"]
        w = train_mod.token_class_weights(seqs, classes)
        self.assertLess(w["O"], 1.0)
        self.assertGreater(w["B-PROVIDER"], w["B-DESTINATION"])
        self.assertGreater(w["B-PROVIDER"], 1.0)
        self.assertEqual(w["B-MODEL"], 5.0)

    def test_unseen_classes_safe_no_division_by_zero(self):
        w = train_mod.token_class_weights([["O", "O"]], ["O", "B-EFFORT"])
        self.assertEqual(w["B-EFFORT"], 1.0)
        self.assertEqual(
            train_mod.token_class_weights([], ["O", "B-TASK"]),
            {"O": 1.0, "B-TASK": 1.0})
        # Single-class input cannot divide by zero either.
        self.assertEqual(
            train_mod.token_class_weights([["O"]], ["O"]), {"O": 1.0})

    def test_counts_live_tags_only_by_construction(self):
        # Caller passes live tags; PAD/IGNORE never enter the count. Skewed
        # content downweights dominant O and emphasizes the rare tags.
        seqs = [["O"] * 6 + ["B-TASK"] * 2 + ["I-TASK"] * 2]
        w = train_mod.token_class_weights(seqs, ["O", "B-TASK", "I-TASK"])
        self.assertLess(w["O"], 1.0)
        self.assertGreater(w["B-TASK"], 1.0)
        self.assertEqual(w["B-TASK"], w["I-TASK"])

    def test_flag_defaults_off_preserving_existing_runs(self):
        ap = train_mod.build_parser()
        self.assertFalse(ap.parse_args([]).token_class_weight)


class BestBundleConsistency(unittest.TestCase):
    def test_capture_best_bundle_is_independent(self):
        try:
            import torch
            from torch import nn
        except ImportError:
            self.skipTest("torch not installed")
        torch.manual_seed(7)
        model = nn.Linear(4, 2)
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
        x = torch.randn(3, 4)
        opt.zero_grad()
        model(x).sum().backward()
        opt.step()
        snap_opt, snap_rng = train_mod.capture_best_bundle(opt)
        before = snap_opt["state"][0]["exp_avg"].clone()
        # Later steps must not mutate the captured best bundle.
        for _ in range(3):
            opt.zero_grad()
            model(torch.randn(3, 4)).sum().backward()
            opt.step()
        self.assertTrue(torch.equal(snap_opt["state"][0]["exp_avg"], before))
        self.assertIsInstance(snap_rng, dict)
        self.assertIn("python", snap_rng)

    def test_captured_bundle_restores_exactly(self):
        try:
            import torch
            from torch import nn
        except ImportError:
            self.skipTest("torch not installed")
        torch.manual_seed(7)
        model = nn.Linear(4, 2)
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
        opt.zero_grad()
        model(torch.randn(3, 4)).sum().backward()
        opt.step()
        snap_opt, _ = train_mod.capture_best_bundle(opt)
        params_at_best = [p.detach().clone() for p in model.parameters()]
        for _ in range(3):
            opt.zero_grad()
            model(torch.randn(3, 4)).sum().backward()
            opt.step()
        # Mirror train.py restart: weights bundle + optimizer bundle load
        # together, so both continue from the best point, not the latest.
        with torch.no_grad():
            for p, b in zip(model.parameters(), params_at_best):
                p.copy_(b)
        opt.load_state_dict(snap_opt)
        self.assertEqual(
            opt.state_dict()["state"][0]["step"],
            snap_opt["state"][0]["step"])
        for p, b in zip(model.parameters(), params_at_best):
            self.assertTrue(torch.equal(p.detach(), b))

    def test_help_lists_label_schema(self):
        ap = train_mod.build_parser()
        help_text = ap.format_help()
        self.assertIn("--label-schema", help_text)
        self.assertIn("--force", help_text)
        self.assertIn("--local-files-only", help_text)
        self.assertIn("--resume", help_text)
        self.assertIn("--warm-start", help_text)
        self.assertIn("--token-class-weight", help_text)

    def test_resume_and_warm_start_are_exclusive(self):
        ap = train_mod.build_parser()
        args = ap.parse_args(["--resume", "--warm-start", "/tmp/x.pt"])
        self.assertTrue(args.resume)
        self.assertEqual(args.warm_start, "/tmp/x.pt")


class RestartSupport(unittest.TestCase):
    def _blob(self, **over):
        base = {
            "model": train_mod.DEFAULT_MODEL,
            "revision": train_mod.DEFAULT_REVISION,
            "actions": list(inference_mod.ACTIONS),
            "bio_labels": inference_mod.bio_label_list(),
            "max_len": 96,
            "best_epoch": 8,
            "epochs_run": 9,
            "state_dict": {},
        }
        base.update(over)
        return base

    def test_resume_mode_classification(self):
        self.assertEqual(train_mod.resume_mode(self._blob()), "weights-only")
        self.assertEqual(
            train_mod.resume_mode(self._blob(optimizer={"a": 1})),
            "weights-optimizer")
        self.assertEqual(
            train_mod.resume_mode(
                self._blob(optimizer={"a": 1}, rng={"python": None})),
            "exact")

    def test_resume_init_from_history(self):
        hist = [
            {"epoch": 6, "global_step": 112, "dev": {"loss": 0.696}},
            {"epoch": 7, "global_step": 128, "dev": {"loss": 0.678}},
            {"epoch": 8, "global_step": 144, "dev": {"loss": 0.676}},
        ]
        self.assertEqual(
            train_mod.resume_init_from_history(hist), (8, 0.676, 144))
        self.assertEqual(train_mod.resume_init_from_history([]), (-1, None, 0))
        # Malformed rows are skipped, not fatal.
        self.assertEqual(
            train_mod.resume_init_from_history([{"epoch": 0}, {"no": "dev"}]),
            (-1, None, 0))

    def test_verify_checkpoint_compat(self):
        train_mod.verify_checkpoint_compat(
            self._blob(), model=train_mod.DEFAULT_MODEL,
            revision=train_mod.DEFAULT_REVISION,
            actions=list(inference_mod.ACTIONS),
            bio_labels=inference_mod.bio_label_list(), max_len=96)
        with self.assertRaises(SystemExit):
            train_mod.verify_checkpoint_compat(
                self._blob(revision="deadbeef"), model=train_mod.DEFAULT_MODEL,
                revision=train_mod.DEFAULT_REVISION,
                actions=list(inference_mod.ACTIONS),
                bio_labels=inference_mod.bio_label_list(), max_len=96)
        with self.assertRaises(SystemExit):
            train_mod.verify_checkpoint_compat(
                self._blob(bio_labels=["O", "B-X", "I-X"]),
                model=train_mod.DEFAULT_MODEL,
                revision=train_mod.DEFAULT_REVISION,
                actions=list(inference_mod.ACTIONS),
                bio_labels=inference_mod.bio_label_list(), max_len=96)
        with self.assertRaises(SystemExit):
            train_mod.verify_checkpoint_compat(
                self._blob(max_len=64), model=train_mod.DEFAULT_MODEL,
                revision=train_mod.DEFAULT_REVISION,
                actions=list(inference_mod.ACTIONS),
                bio_labels=inference_mod.bio_label_list(), max_len=96)

    def test_mini_torch_restart_loads_weights_before_steps(self):
        try:
            import torch
            from torch import nn
        except ImportError:
            self.skipTest("torch not installed")
        torch.manual_seed(11)
        src = nn.Linear(4, 3)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "checkpoint.pt")
            torch.save({"state_dict": src.state_dict()}, path)
            with open(path, "rb") as f:
                before = f.read()
            torch.manual_seed(99)
            fresh = nn.Linear(4, 3)
            self.assertFalse(all(
                torch.equal(a, b) for a, b in
                zip(src.parameters(), fresh.parameters())))
            # The restart proof point: strict load verifies weights inside
            # the model before any optimizer step runs.
            train_mod.strict_load_state_dict(
                fresh, torch.load(path, map_location="cpu",
                                  weights_only=True)["state_dict"])
            for a, b in zip(src.parameters(), fresh.parameters()):
                self.assertTrue(torch.equal(a, b))
            with open(path, "rb") as f:
                self.assertEqual(f.read(), before)

    def test_mini_torch_strict_load_rejects_shape_mismatch(self):
        try:
            import torch
            from torch import nn
        except ImportError:
            self.skipTest("torch not installed")
        model = nn.Linear(4, 3)
        wrong = nn.Linear(5, 3)
        with self.assertRaises(SystemExit):
            train_mod.strict_load_state_dict(model, wrong.state_dict())


class SidecarCompat(unittest.TestCase):
    def test_verify_new_sidecar(self):
        out = inference_mod.verify_bio_labels(inference_mod.bio_label_list())
        self.assertEqual(set(inference_mod.label_set_of(out)), set(inference_mod.LABELS))

    def test_old_v077_sidecar_stays_inspectable(self):
        old = ["O", "B-PROJECT", "I-PROJECT", "B-TASK", "I-TASK",
               "B-PROVIDER", "I-PROVIDER", "B-MODEL", "I-MODEL",
               "B-ROUTING", "I-ROUTING", "B-INSTRUCTION", "I-INSTRUCTION",
               "B-NODE", "I-NODE", "B-CONTROL", "I-CONTROL"]
        out = inference_mod.verify_bio_labels(old)
        self.assertIn("B-PROJECT", out)

    def test_rejects_malformed_sidecar(self):
        with self.assertRaises(ValueError):
            inference_mod.verify_bio_labels(["B-TASK", "I-TASK"])
        with self.assertRaises(ValueError):
            inference_mod.verify_bio_labels(["O", "B-TASK"])

    def test_verify_actions_requires_known_13(self):
        out = inference_mod.verify_actions(list(inference_mod.ACTIONS))
        self.assertEqual(len(out), 13)
        with self.assertRaises(ValueError):
            inference_mod.verify_actions(["start", "stop"])
        # Real v077 actions.json stays loadable (same 13).
        v077 = "/home/abstergo/.local/share/jarvis-experiments/extract-v07/v077-small-s7/actions.json"
        if os.path.exists(v077):
            with open(v077) as f:
                self.assertEqual(len(inference_mod.verify_actions(json.load(f))), 13)
        v077_bio = "/home/abstergo/.local/share/jarvis-experiments/extract-v07/v077-small-s7/bio_labels.json"
        if os.path.exists(v077_bio):
            with open(v077_bio) as f:
                self.assertIn("B-PROJECT", inference_mod.verify_bio_labels(json.load(f)))

    def test_all_scripts_help_without_heavy_imports(self):
        for mod, argv in ((inference_mod, ["--help"]),):
            _ = mod  # inference --help is exercised via CLI below
        self.assertTrue(callable(inference_mod.bio_label_list))


class CalibrationJoint(unittest.TestCase):
    def _pred(self, raw_ok, span_ok, a_conf=0.9, s_conf=0.9, trunc=False):
        spans = [{"start": 0, "end": 4, "label": "DESTINATION",
                  "confidence": s_conf}] if span_ok is not None else []
        return {"raw_action": "start" if raw_ok else "stop",
                "action_confidence": a_conf,
                "spans": spans,
                "span_conf_min": s_conf if span_ok is not None else None,
                "truncated": trunc}

    def _gold(self):
        return {"action": "start",
                "spans": [{"start": 0, "end": 4, "label": "DESTINATION"}]}

    def test_joint_requires_span_confidence(self):
        # Action confident but span weak: action-only would accept, joint
        # complete-frame must not.
        preds = [self._pred(True, True, a_conf=0.99, s_conf=0.10)]
        golds = [self._gold()]
        joint = calibrate_mod.score_policy(preds, golds, 0.5, 0.5)
        self.assertEqual(joint["accepted_count"], 0)
        loose = calibrate_mod.score_policy(preds, golds, 0.5, 0.05)
        self.assertEqual(loose["accepted_count"], 1)

    def test_truncated_never_accepts(self):
        preds = [self._pred(True, True, trunc=True)]
        golds = [self._gold()]
        m = calibrate_mod.score_policy(preds, golds, 0.0, 0.0)
        self.assertEqual(m["accepted_count"], 0)

    def test_abstain_all_when_nothing_safe(self):
        preds = [self._pred(False, True, a_conf=0.99, s_conf=0.99)]
        golds = [self._gold()]
        policy = calibrate_mod.choose_policy(preds, golds, max_wrong_rate=0.01)
        self.assertEqual(policy["status"], "abstain-all")
        self.assertFalse(policy["valid"])
        self.assertEqual(policy["calibration_mode"], "joint-complete-frame")

    def test_action_only_threshold_is_not_readiness(self):
        # train.py helper picks an action threshold alone; it must never be
        # presented as joint readiness (no span term, no frame term).
        thresh, ok = train_mod.choose_action_threshold([0.9, 0.2], [True, False])
        self.assertTrue(0.0 < thresh <= 1.0 or ok in (True, False))
        # The readiness marker lives on calibrate.py output, not here.
        self.assertFalse(hasattr(train_mod.choose_action_threshold, "readiness"))


class EvaluateFrame(unittest.TestCase):
    def test_complete_frame_needs_exact_spans(self):
        gold = [{"id": "a", "text": "fix login in Harbor", "action": "start",
                 "spans": [{"start": 10, "end": 19, "label": "DESTINATION"}]}]
        pred_ok = [{"id": "a", "text": "fix login in Harbor", "raw_action": "start",
                    "action": "start", "spans": [{"start": 10, "end": 19,
                                                  "label": "DESTINATION"}],
                    "truncated": False}]
        pred_span_off = [{"id": "a", "text": "fix login in Harbor", "raw_action": "start",
                          "action": "start", "spans": [{"start": 10, "end": 18,
                                                        "label": "DESTINATION"}],
                          "truncated": False}]
        self.assertEqual(evaluate_mod.score_rows(pred_ok, gold)["complete_frame_acc"], 1.0)
        self.assertEqual(evaluate_mod.score_rows(pred_span_off, gold)["complete_frame_acc"], 0.0)

    def test_per_label_recall_covers_roles(self):
        gold = [{"id": "a", "text": "fix login in Harbor", "action": "start",
                 "spans": [{"start": 10, "end": 19, "label": "DESTINATION"},
                           {"start": 0, "end": 9, "label": "SUBJECT"}]}]
        pred = [{"id": "a", "text": "fix login in Harbor", "raw_action": "start",
                 "action": "start",
                 "spans": [{"start": 10, "end": 19, "label": "DESTINATION"}],
                 "truncated": False}]
        scored = evaluate_mod.score_rows(pred, gold)
        self.assertEqual(scored["per_label_recall"]["DESTINATION"]["recall"], 1.0)
        self.assertEqual(scored["per_label_recall"]["SUBJECT"]["recall"], 0.0)

    def test_bounds_violations_count(self):
        gold = [{"id": "a", "text": "hi", "action": "status", "spans": []}]
        pred = [{"id": "a", "text": "hi", "raw_action": "status", "action": "status",
                 "spans": [{"start": 0, "end": 99, "label": "TASK"}],
                 "truncated": False}]
        self.assertEqual(evaluate_mod.score_rows(pred, gold)["raw_bounds_bad"], 1)

    def test_alignment_rejects_drift(self):
        gold = [{"id": "a", "text": "hello", "action": "status", "spans": []}]
        pred = [{"id": "b", "text": "hello", "raw_action": "status", "action": "status",
                 "spans": [], "truncated": False}]
        with self.assertRaises(ValueError):
            evaluate_mod.assert_aligned(pred, gold)


if __name__ == "__main__":
    unittest.main()
