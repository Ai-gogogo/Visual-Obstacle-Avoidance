"""Assess obstacle candidates across consecutive frames of one camera stream."""

from tracking import MAX_GAP_MS

MIN_CONFIDENCE = 0.50
MIN_URGENT_HEIGHT = 0.25
NEAR_URGENT_BOTTOM = 0.80
UNKNOWN_URGENT_BOTTOM = 0.90
# Measured stereo distance replaces the box-size proxy when the object has one.
URGENT_DEPTH_M = 1.2
CAUTION_DEPTH_M = 3.0
CHAIR_CAUTION_DEPTH_M = 1.5


def urgent_now(obj):
    depth_m = obj.get("depth_m")
    if isinstance(depth_m, (int, float)) and depth_m > 0:
        return depth_m <= URGENT_DEPTH_M
    _, top, _, bottom = obj["bbox"]
    depth = obj.get("relative_depth", "unknown")
    urgent_bottom = NEAR_URGENT_BOTTOM if depth == "near" else UNKNOWN_URGENT_BOTTOM
    return depth != "far" and bottom >= urgent_bottom and bottom - top >= MIN_URGENT_HEIGHT


def beyond_caution(obj):
    depth_m = obj.get("depth_m")
    return isinstance(depth_m, (int, float)) and depth_m > CAUTION_DEPTH_M


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
            chair = obj.get("label") == "chair"
            if chair:
                distance = obj.get("depth_m")
                if not isinstance(distance, (int, float)) or not 0 < distance <= CHAIR_CAUTION_DEPTH_M:
                    continue
            if candidate_2d and not beyond_caution(obj):
                current[track_id] = not chair and urgent_now(obj)
            if metric and obj["obstacle_candidate"]:
                current_metric[track_id] = not chair and urgent_3d

            evidence, previous = (current_metric, self.previous_metric) if metric else (current, self.previous)
            if consecutive and track_id in evidence and track_id in previous:
                obj["risk"] = "urgent" if evidence[track_id] and previous[track_id] else "caution"

        self.previous = current
        self.previous_metric = current_metric
        self.stamp = stamp
