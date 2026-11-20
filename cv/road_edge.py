"""Locate sidewalk-to-road crossings ahead of camera A in its raw image coordinates."""
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from obstacles import PATH_LEFT, PATH_RIGHT, is_obstacle_candidate

DEFAULT_ROAD_CONFIG = Path(__file__).with_name("road_config.json")


class RoadSegmenter:
    """Cityscapes SegFormer-B0, logits 0=road and 1=sidewalk."""
    def __init__(self, path):
        import onnxruntime as ort
        if not path.is_file():
            raise ValueError(f"Missing road model {path}. See cv/README.md for the download.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])

    def __call__(self, image, confidence):
        rgb = np.asarray(image.resize((512, 512), Image.Resampling.BILINEAR), dtype=np.float32) / 255
        rgb -= np.array([.485, .456, .406], np.float32)
        rgb /= np.array([.229, .224, .225], np.float32)
        tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])
        logits = self.session.run(None, {"pixel_values": tensor})[0][0]
        scores = np.exp(logits - logits.max(axis=0))
        probs = scores[:2] / scores.sum(axis=0)
        return tuple(cv2.resize(p, image.size) >= confidence for p in probs)


class RoadEdge:
    @classmethod
    def load(cls, path, stereo):
        config = json.loads(path.read_text(encoding="utf-8"))
        return cls(config, stereo, RoadSegmenter(path.parent / config["model"]))

    def __init__(self, config, stereo, segment):
        self.stereo = stereo
        self.segment = segment
        pitch, self.width, self.caution, self.urgent, self.margin, self.confidence = (
            float(config[key]) for key in ("pitch_down_deg", "corridor_width_m", "caution_m", "urgent_m",
                                          "rearm_margin_m", "min_confidence"))
        if not (all(math.isfinite(v) for v in (self.width, self.caution, self.margin))
                and -60 <= pitch <= 60 and self.width > 0 and 0 < self.urgent < self.caution
                and self.margin > 0 and .5 < self.confidence < 1):
            raise ValueError("Check road pitch, corridor width, confidence and warning distances")
        self.sin = math.sin(math.radians(pitch))
        self.cos = math.cos(math.radians(pitch))

    def __call__(self, image, depth):
        road, sidewalk = self.segment(image, self.confidence)
        return self.locate(road, sidewalk, depth)

    def locate(self, road, sidewalk, depth):
        h, w = road.shape
        r = max(2, round(h * .014))
        # Only pavement connected to the foreground can be the approach side.
        _, regions = cv2.connectedComponents(sidewalk.astype(np.uint8))
        foreground = np.unique(regions[3*h//4:, w//4:3*w//4])
        pavement = np.isin(regions, foreground[foreground != 0])
        # Along a forward ray the road lies above (beyond) the sidewalk.
        band = np.zeros_like(road, dtype=np.uint8)
        band[r:-r] = road[:-2*r] & pavement[2*r:]
        count, components, stats, _ = cv2.connectedComponentsWithStats(band)
        metric = []
        visual = []
        for i in range(1, count):
            x, y, width, height, _ = stats[i]
            if width < max(7, round(w*.025)):
                continue
            ys, xs = np.nonzero(components[y:y+height, x:x+width] == i)
            # One edge sample per column, at the middle of the transition band.
            columns = np.unique(xs)
            rows = np.bincount(xs, weights=ys, minlength=width) / np.maximum(1, np.bincount(xs, minlength=width))
            u, v = columns+x, np.rint(rows[columns]).astype(int)+y
            calibrated = self.stereo is not None and self.stereo.size == (w, h)
            needed = max(6, round(w * .018))
            if calibrated:
                pixels = np.stack([u, v], axis=-1).astype(np.float32)
                rays = cv2.undistortPoints(pixels[:, None], *self.stereo.camera_a).reshape(-1, 2)
                groundward = self.sin + rays[:, 1]*self.cos > 0
                central = groundward & (np.abs(rays[:, 0]) < self.width/(2*self.caution))
                if depth is not None:
                    estimates, outside = self.measure(u, v, rays, groundward, road, sidewalk, depth, r, needed)
                    metric.extend(estimates)
                    central[outside] = False
            else:
                # Reuse the normal obstacle detector's forward region for the uncalibrated visual cue.
                bbox = (u.min()/w, v.min()/h, (u.max()+1)/w, (v.max()+1)/h)
                if not is_obstacle_candidate(bbox):
                    continue
                central = (u >= PATH_LEFT*w) & (u <= PATH_RIGHT*w)
            if np.count_nonzero(central) >= needed:
                j = np.flatnonzero(central)[np.argmin(np.abs(u[central] - w/2))]
                visual.append((v[j], u[j]))
        if metric:
            distance, x, y = min(metric)
            if distance <= self.urgent:
                level = "urgent"
            elif distance <= self.caution:
                level = "caution"
            elif distance > self.caution + self.margin:
                level = "clear"
            else:
                level = "hold"
            return {"level": level, "distance_m": round(distance, 3), "point": [x/w, y/h]}
        if visual:
            y, x = max(visual)
            return {"level": "visual", "point": [float(x/w), float(y/h)]}
        return {"level": "unseen"}

    def measure(self, u, v, rays, groundward, road, sidewalk, depth, radius, needed):
        """Find supported stretches of the edge inside the metric walking corridor."""
        yy = (v + np.arange(-radius, radius+1)[:, None]).clip(0, depth.shape[0]-1)
        samples = np.where(road[yy, u] | sidewalk[yy, u], depth[yy, u], np.nan)
        good = np.isfinite(samples).sum(axis=0) >= max(3, radius//2)
        if not good.any():
            return [], np.array([], dtype=int)
        q1, z, q3 = np.nanpercentile(samples[:, good], [25, 50, 75], axis=0)
        forward = z * (self.cos - rays[good, 1]*self.sin)
        lateral = z * rays[good, 0]
        reliable = groundward[good] & (forward > 0) & ((q3-q1) < np.maximum(.2, .15*z))
        inside = reliable & (np.abs(lateral) <= self.width/2)
        indexes = np.flatnonzero(inside)
        estimates = []
        cols, rows = u[good], v[good]
        for run in np.split(indexes, np.flatnonzero(np.diff(cols[indexes]) > 3)+1):
            for start in range(0, len(run)-needed+1, max(1, needed//2)):
                window = run[start:start+needed]
                values = forward[window]
                distance = float(np.median(values))
                if np.ptp(np.percentile(values, [20, 80])) <= max(.2, distance*.15):
                    j = window[np.argmin(np.abs(values-distance))]
                    estimates.append((distance, int(cols[j]), int(rows[j])))
        # Good depths outside the corridor must not turn into a distance-free alert.
        return estimates, np.flatnonzero(good)[reliable & ~inside]
