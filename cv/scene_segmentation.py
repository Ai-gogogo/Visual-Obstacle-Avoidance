"""Camera A scene labels in the original view. Label 255 means low confidence."""
import base64
from collections import OrderedDict
from pathlib import Path
from threading import Condition, Thread
import sys
import time

import cv2
import numpy as np
import requests
from PIL import Image


DEFAULT_SCENE_MODEL = Path(__file__).with_name("models") / "scene-segformer-b0.onnx"


class SegFormer:
    def __init__(self, path):
        import onnxruntime as ort
        if not path.is_file():
            raise ValueError(f"Missing segmentation model {path}. See cv/README.md for setup.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])

    def logits(self, image):
        rgb = np.asarray(image.resize((512, 512), Image.Resampling.BILINEAR), dtype=np.float32) / 255
        rgb -= np.array([.485, .456, .406], np.float32)
        rgb /= np.array([.229, .224, .225], np.float32)
        tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])
        return self.session.run(None, {"pixel_values": tensor})[0][0]


class SceneSegmenter(SegFormer):
    def labels(self, image, confidence=.55):
        logits = self.logits(image)
        if logits.shape != (150, 128, 128):
            raise ValueError(f"Expected ADE20K SegFormer-B0 logits, got {logits.shape}")
        labels = logits.argmax(axis=0).astype(np.uint8)
        # In a max-shifted softmax the winning numerator is exactly one.
        logits -= logits.max(axis=0)
        np.exp(logits, out=logits)
        labels[logits.sum(axis=0) > 1 / confidence] = 255
        return labels


class SceneSampler:
    """One inference at a time, retaining only the newest offered A frame per source."""
    def __init__(self, segmenter, api, fps):
        self.segmenter = segmenter
        self.api = api
        self.period = 1 / fps
        self.pending = OrderedDict()
        self.condition = Condition()
        self.closed = False
        self.thread = Thread(target=self.run, name="scene-segmentation")

    def offer(self, source, frame_id, image):
        with self.condition:
            self.pending[source] = (frame_id, image)
            self.condition.notify()

    def close(self):
        with self.condition:
            self.closed = True
            self.pending.clear()
            self.condition.notify()
        self.thread.join()

    def run(self):
        next_start = 0
        last_error = None
        with requests.Session() as http:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.closed or self.pending)
                    if self.closed:
                        return
                    delay = next_start - time.monotonic()
                    if delay > 0:
                        self.condition.wait_for(lambda: self.closed, timeout=delay)
                    if self.closed:
                        return
                    source, (frame_id, image) = self.pending.popitem(last=False)
                next_start = time.monotonic() + self.period
                try:
                    labels = self.segmenter.labels(image)
                    ok, encoded = cv2.imencode(".png", labels)
                    if not ok:
                        raise ValueError("Could not encode scene label map")
                    result = http.post(self.api + "/segmentation",
                        params={"camera_id": "A", "source_id": source}, timeout=2,
                        json={"frame_id": frame_id, "width": image.width, "height": image.height,
                              "mask": base64.b64encode(encoded).decode("ascii")})
                    if result.status_code not in (404, 409):
                        result.raise_for_status()
                    last_error = None
                except Exception as error:
                    # Native inference errors must not permanently stop the live sampler.
                    if str(error) != last_error:
                        print(f"Camera A segmentation skipped: {error}", file=sys.stderr)
                    last_error = str(error)
