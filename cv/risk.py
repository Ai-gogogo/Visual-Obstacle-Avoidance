"""Assess obstacle candidates across consecutive frames of one camera stream."""

from tracking import MAX_GAP_MS

MIN_CONFIDENCE = 0.50
MIN_URGENT_HEIGHT = 0.25
NEAR_URGENT_BOTTOM = 0.80
UNKNOWN_URGENT_BOTTOM = 0.90


class RiskAssessment:
    def __init__(self):
        self.previous = {}
        self.previous_metric = {}
        self.stamp = None

    def update(self, objects, stamp, *, metric_evidence=None):
        """Confirm each rule on consecutive frames. Keep 2D history for fallback."""
        metric_evidence = metric_evidence or {}
        consecutive = self.stamp is not None and 0 < stamp - self.stamp <= MAX_GAP_MS
        current = {}
        current_metric = {}
        for index, obj in enumerate(objects):
            obj["risk"] = "normal"
            track_id = obj.get("track_id")
            if not track_id or obj["confidence"] < MIN_CONFIDENCE:
                continue

            metric = index in metric_evidence
            candidate_2d, urgent_3d = metric_evidence.get(index, (obj["obstacle_candidate"], False))
            if candidate_2d:
                _, top, _, bottom = obj["bbox"]
                depth = obj.get("relative_depth", "unknown")
                urgent_bottom = NEAR_URGENT_BOTTOM if depth == "near" else UNKNOWN_URGENT_BOTTOM
                current[track_id] = (depth != "far" and bottom >= urgent_bottom
                                     and bottom - top >= MIN_URGENT_HEIGHT)
            if metric and obj["obstacle_candidate"]:
                current_metric[track_id] = urgent_3d

            evidence, previous = (current_metric, self.previous_metric) if metric else (current, self.previous)
            if consecutive and track_id in evidence and track_id in previous:
                obj["risk"] = "urgent" if evidence[track_id] and previous[track_id] else "caution"

        self.previous = current
        self.previous_metric = current_metric
        self.stamp = stamp
