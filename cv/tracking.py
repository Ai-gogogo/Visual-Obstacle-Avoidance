"""Associate YOLO boxes within a single paired camera stream."""
from dataclasses import dataclass

import numpy as np
from scipy.optimize import linear_sum_assignment

MAX_GAP_MS = 1200
MIN_IOU = 0.20


def overlap(a, b):
    """Intersection over union of two normalized xyxy boxes."""
    width = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    intersection = width * height
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection / union if union > 0 else 0


@dataclass
class Track:
    id: str
    label: str
    box: list
    stamp: int
    vx: float = 0
    vy: float = 0

    def predict(self, stamp):
        # Bound extrapolation when a detection was briefly missed.
        dt = min(stamp - self.stamp, 500)
        dx, dy = dt * self.vx, dt * self.vy
        x1, y1, x2, y2 = self.box
        return [x1 + dx, y1 + dy, x2 + dx, y2 + dy]

    def observe(self, box, stamp):
        dt = stamp - self.stamp
        if dt > 0:
            self.vx = ((box[0] + box[2]) - (self.box[0] + self.box[2])) / (2 * dt)
            self.vy = ((box[1] + box[3]) - (self.box[1] + self.box[3])) / (2 * dt)
        self.box, self.stamp = box, stamp


class FrameTracker:
    def __init__(self, stream_id, side, ids):
        self.stream_id = stream_id
        self.side = side
        self.ids = ids
        self.tracks = []

    def update(self, objects, stamp):
        self.tracks = [t for t in self.tracks if 0 <= stamp - t.stamp <= MAX_GAP_MS]
        scores = np.zeros((len(self.tracks), len(objects)))
        for i, track in enumerate(self.tracks):
            predicted = track.predict(stamp)
            for j, obj in enumerate(objects):
                if obj["label"] == track.label:
                    # The previous box also helps when a moving object stops.
                    score = max(overlap(predicted, obj["bbox"]), .8 * overlap(track.box, obj["bbox"]))
                    if score >= MIN_IOU:
                        scores[i, j] = score

        rows, cols = linear_sum_assignment(scores, maximize=True)
        matches = {j: self.tracks[i] for i, j in zip(rows, cols) if scores[i, j] > 0}
        for j, obj in enumerate(objects):
            track = matches.get(j)
            if track is None:
                track = Track(f"{self.side}-{next(self.ids)}", obj["label"], obj["bbox"], stamp)
                self.tracks.append(track)
            else:
                track.observe(obj["bbox"], stamp)
            obj["track_id"] = track.id
        return objects
