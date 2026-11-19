"""Assess obstacle candidates across consecutive frames of one camera stream."""

from tracking import MAX_GAP_MS

MIN_CONFIDENCE = 0.50
MIN_URGENT_HEIGHT = 0.25
NEAR_URGENT_BOTTOM = 0.80
UNKNOWN_URGENT_BOTTOM = 0.90


class RiskAssessment:
    def __init__(self):
        self.previous = {}
        self.stamp = None

    def update(self, objects, stamp):
        consecutive = self.stamp is not None and 0 < stamp - self.stamp <= MAX_GAP_MS
        current = {}
        for obj in objects:
            obj["risk"] = "normal"
            track_id = obj.get("track_id")
            if not track_id or not obj["obstacle_candidate"] or obj["confidence"] < MIN_CONFIDENCE:
                continue

            _, top, _, bottom = obj["bbox"]
            depth = obj.get("relative_depth", "unknown")
            urgent_bottom = NEAR_URGENT_BOTTOM if depth == "near" else UNKNOWN_URGENT_BOTTOM
            urgent = depth != "far" and bottom >= urgent_bottom and bottom - top >= MIN_URGENT_HEIGHT
            current[track_id] = urgent
            if consecutive and track_id in self.previous:
                obj["risk"] = "urgent" if urgent and self.previous[track_id] else "caution"

        self.previous = current
        self.stamp = stamp
