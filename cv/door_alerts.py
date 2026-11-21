"""Find doors in Camera A's ADE20K segmentation and measure their visible surface."""
from collections import OrderedDict
from pathlib import Path
from threading import Condition, Thread
import sys
import time

import cv2
import numpy as np
import requests
from PIL import Image

from obstacles import is_obstacle_candidate


DEFAULT_DOOR_MODEL = Path(__file__).with_name("models") / "scene-segformer-b0.onnx"
DOOR_CLASS = 14
MIN_CONFIDENCE = .55


class DoorSegmenter:
    def __init__(self, path):
        import onnxruntime as ort

        if not path.is_file():
            raise ValueError(f"Missing ADE20K door model {path}. See cv/README.md for setup.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])

    def __call__(self, image, depth):
        # Same ADE20K SegFormer-B0 preprocessing as the scene segmentation worker.
        rgb = np.asarray(image.resize((512, 512), Image.Resampling.BILINEAR), dtype=np.float32) / 255
        rgb -= np.array([.485, .456, .406], np.float32)
        rgb /= np.array([.229, .224, .225], np.float32)
        tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])
        logits = self.session.run(None, {"pixel_values": tensor})[0][0]
        if logits.shape != (150, 128, 128):
            raise ValueError(f"Expected ADE20K SegFormer-B0 logits, got {logits.shape}")
        door = logits.argmax(axis=0) == DOOR_CLASS
        # The winning class has numerator one after the softmax shift.
        logits -= logits.max(axis=0)
        np.exp(logits, out=logits)
        door &= logits.sum(axis=0) <= 1 / MIN_CONFIDENCE
        return observe_door(door, depth)


def observe_door(mask, depth):
    height, width = mask.shape
    _, components, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    candidates = []
    for label, (x, y, w, h, area) in enumerate(stats[1:], start=1):
        box = [x / width, y / height, (x + w) / width, (y + h) / height]
        if area < .01 * width * height or not is_obstacle_candidate(box):
            continue
        distance = door_depth(components == label, depth) if depth is not None else None
        candidates.append((distance if distance is not None else float("inf"), -area, box))
    if not candidates:
        return None
    distance, _, box = min(candidates)
    return {"bbox": box, **({"distance_m": distance} if np.isfinite(distance) else {})}


def door_depth(mask, depth):
    # Exclude the mask edge, where depth can belong to the wall or the doorway behind it.
    interior = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8),
                         borderType=cv2.BORDER_CONSTANT, borderValue=0)
    interior = cv2.resize(interior, depth.shape[::-1], interpolation=cv2.INTER_NEAREST).astype(bool)
    values = depth[interior]
    valid = values[np.isfinite(values) & (values > 0)]
    if valid.size < max(30, values.size * .20):
        return None
    lower, median, upper = np.percentile(valid, [25, 50, 75])
    if upper - lower > max(.25, median * .25):
        return None
    return float(median)


class DoorSampler:
    """Run segmentation off the detection path and retain only the latest frame per source."""
    def __init__(self, segment, api):
        self.segment = segment
        self.api = api
        self.pending = OrderedDict()
        self.condition = Condition()
        self.closed = False
        self.thread = Thread(target=self.run, name="door-segmentation")

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        with self.condition:
            self.closed = True
            self.condition.notify()
        self.thread.join()

    def offer(self, source, frame_id, image, depth, partner_id):
        with self.condition:
            self.pending[source] = (frame_id, image, depth, partner_id)
            self.condition.notify()

    def run(self):
        next_start = 0.
        last_error = None
        with requests.Session() as http:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.closed or self.pending)
                    delay = next_start - time.monotonic()
                    if delay > 0 and not self.closed:
                        self.condition.wait_for(lambda: self.closed, timeout=delay)
                    if self.closed:
                        return
                    source, (frame_id, image, depth, partner_id) = self.pending.popitem(last=False)
                next_start = time.monotonic() + 1 / 3
                try:
                    observation = self.segment(image, depth)
                    response = http.post(self.api + "/door", params={"camera_id": "A", "source_id": source},
                                         json={"frame_id": frame_id, "partner_id": partner_id, "door": observation},
                                         timeout=1)
                    if response.status_code not in (404, 409):
                        response.raise_for_status()
                    last_error = None
                except Exception as error:
                    if str(error) != last_error:
                        print(f"Camera A door segmentation skipped: {error}", file=sys.stderr)
                        last_error = str(error)
