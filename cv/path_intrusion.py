"""Predict a moving track entering the forward corridor of a calibrated stereo rig."""
from dataclasses import dataclass
import json
import math

import cv2
import numpy as np

from geometry import deproject
from mask_utils import InstanceMask, dilate_mask
from risk import MIN_CONFIDENCE
from tracking import MAX_GAP_MS

MOVING_CLASSES = {"person", "bicycle", "motorcycle", "car", "bus", "truck", "dog"}
MIN_FEATURES = 18
CAMERA_RIGHT = np.array([1., 0., 0.])
ESTIMATE_MOTION = object()


@dataclass(frozen=True)
class Corridor:
    half_width: float
    forward_axis: np.ndarray
    horizon: float
    reach: float
    max_turn_rate: float

    @classmethod
    def load(cls, path):
        config = json.loads(path.read_text(encoding="utf-8"))
        options = config.get("intrusion", {})
        enabled = options.get("enabled", True)
        if type(enabled) is not bool:
            raise ValueError("intrusion.enabled must be true or false")
        if not enabled:
            return None
        pitch = float(config["pitch_down_deg"])
        width = float(config["corridor_width_m"])
        horizon = float(options.get("horizon_s", 2))
        reach = float(options.get("max_forward_m", 6))
        rate = float(options.get("max_turn_deg_s", 35))
        if not (-60 <= pitch <= 60 and 0 < width <= 5 and 0 < horizon <= 3 and
                0 < reach <= 30 and 0 < rate <= 90):
            raise ValueError("Check pitch, walking width and intrusion prediction limits")
        angle = math.radians(pitch)
        return cls(width/2, np.array([0, -math.sin(angle), math.cos(angle)]), horizon, reach, rate)


def background_mask(shape, objects, *, masks=None, dilate_px=4):
    """Exclude dilated silhouettes where available, otherwise padded boxes."""
    if dilate_px < 0:
        raise ValueError("mask radius must be nonnegative")
    h, w = shape
    mask = np.full(shape, 255, np.uint8)
    silhouette = None
    pairs = ((obj, None) for obj in objects) if masks is None else zip(objects, masks, strict=True)
    for obj, instance in pairs:
        if instance is not None:
            pixels = instance.pixels if isinstance(instance, InstanceMask) else np.asarray(instance, dtype=bool)
            if pixels.shape != shape:
                raise ValueError("instance mask and background must have the same shape")
            if silhouette is None:
                silhouette = pixels.copy()
            else:
                np.logical_or(silhouette, pixels, out=silhouette)
            continue
        x1, y1, x2, y2 = np.asarray(obj["bbox"]) * [w, h, w, h]
        pad = max(5, round(.06 * max(x2-x1, y2-y1)))
        mask[max(0, int(y1)-pad):int(y2)+pad+1, max(0, int(x1)-pad):int(x2)+pad+1] = 0
    if silhouette is not None:
        # Dilation distributes over union, so one operation excludes every silhouette.
        expanded = dilate_mask(silhouette, radius_px=dilate_px)
        cv2.subtract(mask, 255, dst=mask, mask=expanded.view(np.uint8))
    return mask


def support_background_mask(shape, objects, *, masks=None):
    """Leave detected tabletops available as support-surface candidates."""
    pairs = ((obj, None) for obj in objects) if masks is None else zip(objects, masks, strict=True)
    foreground = [(obj, mask) for obj, mask in pairs if obj["label"] != "dining table"]
    return background_mask(shape, [obj for obj, _ in foreground],
                           masks=[mask for _, mask in foreground] if masks is not None else None)


@dataclass
class Frame:
    gray: np.ndarray
    depth: np.ndarray
    background: np.ndarray
    stamp: int
    positions: dict


def background_pose(previous, current, camera, max_turn_rate):
    """Fit previous static 3-D points to current pixels. Return old->new R,t or abstain."""
    valid = previous.background & (np.isfinite(previous.depth).astype(np.uint8)*255)
    # Keep feature windows off depth holes, occlusion boundaries and detected objects.
    valid = cv2.erode(valid, np.ones((3, 3), np.uint8))
    points = cv2.goodFeaturesToTrack(previous.gray, 300, .012, 7, mask=valid)
    if points is None or len(points) < MIN_FEATURES:
        return None
    flow = dict(winSize=(21, 21), maxLevel=3)
    targets, found, _ = cv2.calcOpticalFlowPyrLK(previous.gray, current.gray, points, None, **flow)
    if targets is None:
        return None
    back, reversed_ok, _ = cv2.calcOpticalFlowPyrLK(current.gray, previous.gray, targets, None, **flow)
    if back is None:
        return None
    p, q = points[:, 0], targets[:, 0]
    h, w = current.gray.shape
    good = (found.ravel().astype(bool) & reversed_ok.ravel().astype(bool) &
            (np.linalg.norm(back[:, 0]-p, axis=1) <= .8) &
            (q[:, 0] >= 1) & (q[:, 0] < w-1) & (q[:, 1] >= 1) & (q[:, 1] < h-1))
    p, q = p[good], q[good]
    u, v = np.rint(q).astype(int).T
    usable = (current.background[v, u] != 0) & np.isfinite(current.depth[v, u])
    p, q = p[usable], q[usable]
    if len(p) < MIN_FEATURES:
        return None
    u, v = np.rint(p).astype(int).T
    xyz = deproject(p, previous.depth[v, u], camera)
    ok, rot, trans, inliers = cv2.solvePnPRansac(
        xyz, q, *camera, iterationsCount=120, reprojectionError=1.8, confidence=.995, flags=cv2.SOLVEPNP_EPNP)
    if not ok or inliers is None or len(inliers) < max(MIN_FEATURES, .65*len(p)):
        return None
    idx = inliers.ravel()
    # A single moving patch or a strip cannot establish global camera motion.
    cells = (q[idx] / [w, h] * [4, 3]).astype(int)
    if len(np.unique(cells, axis=0)) < 5 or np.any(np.ptp(q[idx], axis=0) < [.38*w, .28*h]):
        return None
    rot, trans = cv2.solvePnPRefineLM(xyz[idx], q[idx], *camera, rot, trans)
    dt = (current.stamp-previous.stamp)/1000
    if math.degrees(np.linalg.norm(rot)) > min(12, max_turn_rate*dt) or np.linalg.norm(trans) > .08+3.5*dt:
        return None
    rotation = cv2.Rodrigues(rot)[0]
    fitted = xyz[idx] @ rotation.T + trans.ravel()
    u, v = np.rint(q[idx]).astype(int).T
    measured = current.depth[v, u]
    if np.mean((fitted[:, 2] > 0) & (np.abs(fitted[:, 2]-measured) < np.maximum(.14, .08*measured))) < .75:
        return None
    return rotation, trans.ravel()


def pose_between(previous, current, camera, max_turn_rate):
    if (previous is None or current.gray.shape != previous.gray.shape
            or not 60 <= current.stamp - previous.stamp <= MAX_GAP_MS):
        return None
    try:
        return background_pose(previous, current, camera, max_turn_rate)
    except cv2.error:
        # Feature geometry can be degenerate.
        return None


class IntrusionPredictor:
    def __init__(self, camera, corridor):
        self.camera = camera
        self.corridor = corridor
        self.previous = None
        self.candidates = {}

    def position(self, obj, w, h):
        x1, y1, x2, y2 = np.asarray(obj["bbox"]) * [w, h, w, h]
        # A truncated box gives a moving centre even for a stationary target.
        if min(x1, y1, w-x2, h-y2) < 2:
            return None
        y = (y1+y2)/2
        left, center, right = deproject([(x1, y), ((x1+x2)/2, y), (x2, y)], obj["depth_m"], self.camera)
        return center, (right-left)/2

    def update(self, gray, depth, objects, stamp, *, axes=None, pose=ESTIMATE_MOTION, background=None):
        positions = {}
        for obj in objects:
            if (obj["label"] in MOVING_CLASSES and obj.get("track_id") and obj["confidence"] >= MIN_CONFIDENCE
                    and obj.get("depth_m", 0) > 0):
                measurement = self.position(obj, gray.shape[1], gray.shape[0])
                if measurement is not None:
                    positions[obj["track_id"]] = measurement
        if not positions:
            self.previous = None
            self.candidates.clear()
            return
        previous = self.previous
        if background is None:
            background = background_mask(gray.shape, objects)
        current = Frame(gray, depth, background, stamp, positions)
        self.previous = current
        earlier, self.candidates = self.candidates, {}
        if previous is None or not (60 <= stamp-previous.stamp <= MAX_GAP_MS):
            return
        if not (positions.keys() & previous.positions.keys()):
            return
        if pose is ESTIMATE_MOTION:
            pose = pose_between(previous, current, self.camera, self.corridor.max_turn_rate)
        if pose is None:
            return
        rotation, translation = pose
        lateral = CAMERA_RIGHT if axes is None else axes[1]
        dt = (stamp-previous.stamp)/1000
        for obj in objects:
            key = obj.get("track_id")
            if key not in positions or key not in previous.positions:
                continue
            center, span = positions[key]
            old_center, old_span = previous.positions[key]
            half_width = abs(span @ lateral)
            old_width = abs((old_span if axes is None else rotation @ old_span) @ lateral)
            if abs(half_width-old_width) > max(.12, .25*old_width):
                continue
            # Rotate old measurements onto today's axes. Retain relative translation
            # for corridor entry, but require the object itself to be moving inward too.
            delta = center - rotation @ old_center
            sign = np.sign(center @ lateral)
            if -sign*((delta-translation) @ lateral) < max(.05, .25*dt) or np.linalg.norm(delta)/dt > 22:
                continue
            velocity = delta/dt
            eta = self.entry_time(center, half_width, velocity, axes)
            if eta is None:
                continue
            self.candidates[key] = (sign, velocity)
            if key not in earlier or earlier[key][0] != sign:
                continue
            old_velocity = rotation @ earlier[key][1]
            if abs((velocity-old_velocity) @ lateral) > max(.45, .5*abs(velocity @ lateral)):
                continue
            eta = self.entry_time(center, half_width, (velocity+old_velocity)/2, axes)
            if eta is not None:
                obj["intrusion"] = {"from_side": "right" if sign > 0 else "left", "eta_s": round(eta, 2)}

    def entry_time(self, center, half_width, velocity, axes=None):
        forward, lateral = (self.corridor.forward_axis, CAMERA_RIGHT) if axes is None else axes
        side = center @ lateral
        clearance = abs(side) - self.corridor.half_width - half_width
        inward = -np.sign(side) * (velocity @ lateral)
        if clearance <= 0 or inward < .25:
            return None
        eta = clearance/inward
        if (eta <= self.corridor.horizon and center @ forward > 0 and
                0 < (center + eta*velocity) @ forward <= self.corridor.reach):
            return eta
        return None
