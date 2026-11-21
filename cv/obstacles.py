"""Flag detections in the forward path using image or metric geometry."""

from dataclasses import dataclass, fields
import json
import math

import cv2
import numpy as np

from geometry import deproject
from plane_ransac import PlaneConfig, height_above_plane



PATH_LEFT = 0.35
PATH_RIGHT = 0.65
PATH_TOP = 0.60
MIN_PATH_OVERLAP = 0.25


def is_obstacle_candidate(bbox):
    """Check a normalized xyxy box against the lower-center image region.

    The lower edge is a proxy for where an object meets the walking surface.
    The overlap threshold ignores boxes that only graze the corridor.
    """
    x1, _, x2, y2 = bbox
    overlap = min(x2, PATH_RIGHT) - max(x1, PATH_LEFT)
    narrower_width = min(x2 - x1, PATH_RIGHT - PATH_LEFT)
    return y2 >= PATH_TOP and overlap >= MIN_PATH_OVERLAP * narrower_width


@dataclass(frozen=True)
class PlaneObstacles:
    fit: PlaneConfig = PlaneConfig()
    min_height_m: float = .05
    half_width_m: float = .45
    caution_m: float = 5.
    urgent_m: float = 3.
    pitch_down_deg: float = 0.

    @classmethod
    def load(cls, path, force=False):
        config = json.loads(path.read_text(encoding="utf-8"))
        options = config.get("plane", {})
        enabled = options.get("enabled", False)
        if type(enabled) is not bool:
            raise ValueError("plane.enabled must be true or false")
        if not (force or enabled):
            return None
        fit = PlaneConfig(**{field.name: options[field.name] for field in fields(PlaneConfig)
                             if field.name in options})
        settings = cls(fit, float(options.get("min_obstacle_height_m", .05)),
                       float(config["corridor_width_m"]) / 2, float(config["caution_m"]),
                       float(config["urgent_m"]), float(config["pitch_down_deg"]))
        if not (0 < settings.min_height_m < math.inf and 0 < settings.half_width_m < math.inf
                and 0 < settings.urgent_m < settings.caution_m < math.inf
                and -60 <= settings.pitch_down_deg <= 60):
            raise ValueError("Check metric obstacle height, corridor, warning distances and pitch")
        if not (0 < fit.inlier_tol_m < math.inf and 0 < fit.holdout_p90_max_m < math.inf
                and 0 < fit.min_inlier_ratio <= 1):
            raise ValueError("Check plane fitting tolerances and inlier ratio")
        counts = (fit.min_train_inliers, fit.min_grid_cells, fit.min_holdout_points,
                  fit.max_sample_points, fit.iterations)
        if (any(type(value) is not int or value < 1 for value in counts)
                or fit.max_sample_points < 3 or fit.min_train_inliers < 3
                or type(fit.seed) is not int or fit.seed < 0):
            raise ValueError("Check plane fitting counts and seed")
        return settings

    def corridor_coordinates(self, points):
        pitch = math.radians(self.pitch_down_deg)
        forward = points[:, 2] * math.cos(pitch) - points[:, 1] * math.sin(pitch)
        inside = (np.abs(points[:, 0]) <= self.half_width_m) & (forward > 0) & (forward <= self.caution_m)
        return inside, forward


def unclassified_obstacles(depth, camera, plane, background, settings):
    """Group unlabelled above-plane pixels within the configured metric corridor."""
    heights = height_above_plane(depth, camera, plane)
    threshold = max(settings.min_height_m, 1.5 * plane.holdout_p90_m)
    y, x = np.nonzero(background & (heights > threshold))
    if not len(y):
        return []
    inside, _ = settings.corridor_coordinates(deproject(np.column_stack((x, y)), depth[y, x], camera))
    y, x = y[inside], x[inside]
    mask = np.zeros(depth.shape, np.uint8)
    mask[y, x] = 1
    _, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    h, w = depth.shape
    components = np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] >= 24) + 1
    result = []
    for component in sorted(components, key=lambda key: -stats[key, cv2.CC_STAT_AREA])[:12]:
        left, top, width, height, _ = stats[component]
        region = np.s_[top:top+height, left:left+width]
        pixels = labels[region] == component
        result.append({
            "bbox": [left / w, top / h, (left + width) / w, (top + height) / h],
            "depth_m": round(float(np.median(depth[region][pixels])), 3),
            "height_above_plane_m": round(float(np.median(heights[region][pixels])), 3),
        })
    return result
