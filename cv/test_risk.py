import unittest

from risk import RiskAssessment
from tracking import MAX_GAP_MS


def obstacle(track_id="A-1", *, bottom=.85, depth="near", confidence=.9, candidate=True,
             depth_m=None, label="bench"):
    extra = {} if depth_m is None else {"depth_m": depth_m}
    return {
        **extra,
        "label": label,
        "track_id": track_id,
        "bbox": [.35, .35, .65, bottom],
        "relative_depth": depth,
        "confidence": confidence,
        "obstacle_candidate": candidate,
    }


class RiskAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.assessment = RiskAssessment()

    def risk(self, stamp, **kwargs):
        obj = obstacle(**kwargs)
        self.assessment.update([obj], stamp)
        return obj["risk"]

    def test_escalation_requires_two_frames_at_each_threshold(self):
        self.assertEqual(self.risk(1, bottom=.70), "normal")
        self.assertEqual(self.risk(201, bottom=.70), "caution")
        self.assertEqual(self.risk(401), "caution")
        self.assertEqual(self.risk(601), "urgent")
        self.assertEqual(self.risk(801, bottom=.70), "caution")

    def test_depth_can_inform_urgency_but_far_does_not_clear_path(self):
        self.assertEqual(self.risk(1, depth="far", bottom=.95), "normal")
        self.assertEqual(self.risk(201, depth="far", bottom=.95), "caution")
        self.assertEqual(self.risk(401, depth="unknown", bottom=.95), "caution")
        self.assertEqual(self.risk(601, depth="unknown", bottom=.95), "urgent")

    def test_measured_distance_overrides_box_size(self):
        self.assertEqual(self.risk(1, bottom=.70, depth_m=1.0), "normal")
        self.assertEqual(self.risk(201, bottom=.70, depth_m=1.0), "urgent")
        self.assertEqual(self.risk(401, bottom=.95, depth_m=2.0), "caution")
        self.assertEqual(self.risk(601, bottom=.95, depth_m=3.5), "normal")
        self.assertEqual(self.risk(801, bottom=.95, depth_m=2.0), "normal")

    def test_chair_requires_two_measurements_inside_1_5_m_and_never_escalates(self):
        cases = [(3.0, "normal"), (1.51, "normal"), (1.5, "normal"), (1.5, "caution"),
                 (1.0, "caution"), (.8, "caution"), (None, "normal"), (1.5, "normal"),
                 (1.5, "caution"), (float("nan"), "normal"), (1.2, "normal")]
        for i, (depth_m, expected) in enumerate(cases):
            with self.subTest(index=i, depth_m=depth_m):
                self.assertEqual(self.risk(1 + i*200, label="chair", depth_m=depth_m), expected)

    def test_confirmation_does_not_carry_across_gaps_or_different_tracks(self):
        self.assertEqual(self.risk(1), "normal")
        self.assertEqual(self.risk(201, track_id="A-2"), "normal")
        stamp = 202 + MAX_GAP_MS
        self.assertEqual(self.risk(stamp, track_id="A-2"), "normal")
        self.assessment.update([], stamp + 100)
        self.assertEqual(self.risk(stamp + 200, track_id="A-2"), "normal")

    def test_low_confidence_or_leaving_path_resets_confirmation(self):
        for fields in ({"confidence": .49}, {"candidate": False}):
            with self.subTest(fields=fields):
                self.assessment = RiskAssessment()
                self.assertEqual(self.risk(1), "normal")
                self.assertEqual(self.risk(201), "urgent")
                self.assertEqual(self.risk(401, **fields), "normal")
                self.assertEqual(self.risk(601), "normal")

    def test_metric_distance_and_fallback_keep_independent_confirmation(self):
        values = []
        for stamp, mode in enumerate((False, False, True, True, None, True), 1):
            obj = obstacle(bottom=.95)
            evidence = {} if mode is None else {0: (True, mode)}
            self.assessment.update([obj], stamp, metric_evidence=evidence)
            values.append(obj["risk"])
        self.assertEqual(values, ["normal", "caution", "caution", "urgent", "urgent", "normal"])
