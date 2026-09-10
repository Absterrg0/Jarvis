"""Calibration readiness regression: valid thresholds are NEVER ready.

Run with stdlib only (no torch/onnxruntime, no model, no data files):
  python3 scripts/jarvis-extract/test_calibration_readiness.py
  python3 -m pytest scripts/jarvis-extract/test_calibration_readiness.py -q

Separate file from test_roles_v08.py (root trainer owns that file).
Covers the reported root failure: policy-thresholds.json marked
readiness:true with useful 15/140 (~10.7%) while the user gate needs
useful_auto >= .80 and the held-out test was never evaluated.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import calibrate as calibrate_mod

HERE = os.path.dirname(os.path.abspath(__file__))
FIXED_MIN_USEFUL = 0.80


def _gold(index: int) -> dict:
    return {
        "action": "start",
        "spans": [{"start": 0, "end": 4, "label": "DESTINATION"}],
        "text": f"t{index}",
        "id": f"r{index}",
    }


def _good_pred(index: int) -> dict:
    return {
        "raw_action": "start",
        "action_confidence": 0.95,
        "spans": [{"start": 0, "end": 4, "label": "DESTINATION",
                   "confidence": 0.95}],
        "span_conf_min": 0.95,
        "truncated": False,
        "text": f"t{index}",
        "id": f"r{index}",
    }


def _bad_pred(index: int) -> dict:
    # Wrong action, no spans: span gate is skipped (None), so only the
    # action threshold can filter it -- mirrors live Extractor behaviour
    # where empty spans yield span_conf_min None.
    return {
        "raw_action": "stop",
        "action_confidence": 0.30,
        "spans": [],
        "span_conf_min": None,
        "truncated": False,
        "text": f"t{index}",
        "id": f"r{index}",
    }


def _read(name: str) -> str:
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return fh.read()


class CalibrationNeverReady(unittest.TestCase):
    def test_low_coverage_valid_thresholds_are_not_readiness(self):
        # Root repro shape: 15 useful / 140 rows = 10.7% << user min 80%,
        # zero accepted errors so threshold selection is valid -- but the
        # output must NOT claim readiness (final test gate never ran).
        preds = [_good_pred(i) for i in range(15)]
        preds += [_bad_pred(i) for i in range(15, 140)]
        golds = [_gold(i) for i in range(140)]
        policy = calibrate_mod.choose_policy(preds, golds, max_wrong_rate=0.01)
        self.assertEqual(policy["status"], "calibrated")
        self.assertTrue(policy["valid"])
        self.assertEqual(policy["metrics"]["useful_auto_count"], 15)
        self.assertAlmostEqual(policy["metrics"]["useful_auto"], 0.1071, places=3)
        self.assertLess(policy["metrics"]["useful_auto"], FIXED_MIN_USEFUL)
        self.assertEqual(policy["metrics"]["request_error_count"], 0)
        # The regression: valid thresholds, readiness explicitly False.
        self.assertFalse(policy["readiness"])
        self.assertTrue(policy.get("calibration_only"))
        self.assertEqual(policy["calibration_mode"], "joint-complete-frame")
        # Thresholds remain consumable by inference gating.
        for key in ("clarify_threshold", "token_threshold"):
            self.assertIsInstance(policy[key], float)
            self.assertGreaterEqual(policy[key], 0.0)
            self.assertLessEqual(policy[key], 1.0)

    def test_perfect_calibration_is_still_not_readiness(self):
        # Even 100% useful on calibration cannot declare readiness:
        # readiness needs the evaluate.py fixed gate on held-out test.
        preds = [_good_pred(i) for i in range(20)]
        golds = [_gold(i) for i in range(20)]
        policy = calibrate_mod.choose_policy(preds, golds, max_wrong_rate=0.01)
        self.assertTrue(policy["valid"])
        self.assertEqual(policy["metrics"]["useful_auto"], 1.0)
        self.assertFalse(policy["readiness"])
        self.assertTrue(policy.get("calibration_only"))

    def test_abstain_all_is_not_readiness(self):
        preds = [_bad_pred(0)]
        # Gold disagrees on action so nothing can be accepted safely.
        golds = [dict(_gold(0), action="start")]
        preds[0]["raw_action"] = "stop"
        preds[0]["action_confidence"] = 0.99
        policy = calibrate_mod.choose_policy(preds, golds, max_wrong_rate=0.01)
        self.assertEqual(policy["status"], "abstain-all")
        self.assertFalse(policy["valid"])
        self.assertFalse(policy["readiness"])
        self.assertTrue(policy.get("calibration_only"))

    def test_source_never_emits_readiness_true(self):
        src = _read("calibrate.py")
        self.assertNotIn('"readiness": True', src)
        self.assertNotIn("'readiness': True", src)
        self.assertNotIn("bool(policy.get(\"valid\"))", src)
        # Fail-closed: main() forces readiness False after choose_policy.
        self.assertIn('policy["readiness"] = False', src)
        self.assertIn("calibration_only", src)


class SchemaConsumers(unittest.TestCase):
    def test_inference_consumes_thresholds_not_readiness(self):
        src = _read("inference.py")
        # Gating inputs: frozen thresholds + max_len.
        for key in ("clarify_threshold", "token_threshold", "max_len"):
            self.assertIn(key, src)
        # Readiness must not gate inference: no readiness key lookup.
        self.assertNotIn('["readiness"]', src)
        self.assertNotIn("get(\"readiness\")", src)
        self.assertNotIn("get('readiness')", src)

    def test_eval_gate_owns_readiness(self):
        src = _read("evaluate.py")
        # Fixed user gate lives in evaluate.py, not calibrate.py.
        self.assertIn("FIXED_MIN_USEFUL", src)
        self.assertIn("gate_fixed", src)
        self.assertIn("0.80", src)
        # Eval verdict never reads a calibrate readiness flag.
        self.assertNotIn('["readiness"]', src)
        self.assertNotIn("get(\"readiness\")", src)
        self.assertNotIn("get('readiness')", src)


if __name__ == "__main__":
    unittest.main()
