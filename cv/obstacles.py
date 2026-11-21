"""Flag detections in the forward path using image or metric geometry."""

from dataclasses import dataclass, fields
import json
import math

import cv2
import numpy as np

from geometry import deproject, ground_axes, pitch_normal
from plane_ransac import PlaneConfig, height_above_plane



PATH_LEFT = 0.35
PATH_RIGHT = 0.65
PATH_TOP = 0.60
MIN_PATH_OVERLAP = 0.25
CITYSCAPES_STATIC_START = 2
CITYSCAPES_STATIC_LABELS = (
    "building", "wall", "fence", "pole", "traffic_light", "traffic_sign", "vegetation", "terrain",
)
CITYSCAPES_STATIC_END = CITYSCAPES_STATIC_START + len(CITYSCAPES_STATIC_LABELS)
SEMANTIC_UNKNOWN_ID = 255


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
    prior_max_age_ms: int = 500
    max_turn_rate: float = 35.

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
        # Older plane configurations used a top-level pair of warning distances.
        legacy_caution = config.get("caution_m", cls.caution_m) if "urgent_m" in config else cls.caution_m
        settings = cls(fit, float(options.get("min_obstacle_height_m", .05)),
                       float(config["corridor_width_m"]) / 2, float(options.get("caution_m", legacy_caution)),
                       float(options.get("urgent_m", config.get("urgent_m", cls.urgent_m))),
                       float(config["pitch_down_deg"]),
                       options.get("prior_max_age_ms", 500),
                       float(config.get("intrusion", {}).get("max_turn_deg_s", 35.)))
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
        if (type(settings.prior_max_age_ms) is not int or settings.prior_max_age_ms < 0
                or not 0 < settings.max_turn_rate <= 90):
            raise ValueError("Check plane prior age and camera turn limit")
        return settings

    def corridor_coordinates(self, points, axes):
        forward, lateral = axes or ground_axes(pitch_normal(math.radians(self.pitch_down_deg)))
        return points @ forward, points @ lateral


def vote_static_class(semantic_region, pixels):
    """Summarize Cityscapes evidence at the pixels of one connected component."""
    classes = semantic_region[pixels]
    valid = classes[(classes >= CITYSCAPES_STATIC_START) & (classes < CITYSCAPES_STATIC_END)]
    if valid.size < 12:
        return {"semantic_label": "unknown"}
    counts = np.bincount(valid - CITYSCAPES_STATIC_START, minlength=len(CITYSCAPES_STATIC_LABELS))
    winner = int(counts.argmax())
    fraction = counts[winner] / valid.size
    if fraction < .50:
        return {"semantic_label": "unknown"}
    return {"semantic_label": CITYSCAPES_STATIC_LABELS[winner], "semantic_confidence": round(float(fraction), 2)}


def unclassified_obstacles(depth, camera, plane, background, settings, axes, *, semantic_map=None):
    """Group unlabelled above-plane pixels within the configured metric corridor."""
    if semantic_map is not None and semantic_map.shape != depth.shape:
        raise ValueError("semantic map and metric depth must have the same shape")
    heights = height_above_plane(depth, camera, plane)
    threshold = max(settings.min_height_m, 1.5 * plane.holdout_p90_m)
    y, x = np.nonzero(background & (heights > threshold))
    if not len(y):
        return []
    points = deproject(np.column_stack((x, y)), depth[y, x], camera)
    forward, lateral = settings.corridor_coordinates(points, axes)
    inside = (np.abs(lateral) <= settings.half_width_m) & (forward > 0) & (forward <= settings.caution_m)
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
        obstacle = {
            "bbox": [left / w, top / h, (left + width) / w, (top + height) / h],
            "depth_m": round(float(np.median(depth[region][pixels])), 3),
            "height_above_plane_m": round(float(np.median(heights[region][pixels])), 3),
        }
        if semantic_map is not None:
            obstacle.update(vote_static_class(semantic_map[region], pixels))
        result.append(obstacle)
    return result
