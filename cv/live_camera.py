"""Publish live Camera A and B detections to the local VisionAssist server."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack
import csv
import io
import sys
from functools import partial
from itertools import count
from pathlib import Path
from threading import Event, Lock

import cv2
import numpy as np
import requests
from PIL import Image, ImageOps

from detect_image import DEFAULT_WEIGHTS, detect
from item_features import item_features
from obstacles import is_obstacle_candidate
from risk import RiskAssessment
from tracking import FrameTracker
from stereo_depth import DEFAULT_CONFIG, StereoDepth, object_depth


class CameraWorker:
    def __init__(self, server, model, session, side="A", record=None, stereo=None, *, infer=None):
        self.side = side
        self.stereo = stereo
        self.record = record
        self.api = server.rstrip("/") + "/api/cv"
        self.model = model
        self.infer = infer
        self.http = session
        self.etags = {}
        self.trackers = {}
        self.risk_assessments = {}
        self.pending = {}  # Preserve the exact payload when a POST acknowledgment is lost.
        self.ids = count(1)

    def poll(self):
        sources = self.http.get(self.api + "/sources", timeout=3)
        sources.raise_for_status()
        active = {s["source_id"]: s.get("frame_id") for s in sources.json()["sources"]
                  if s["camera_id"] == self.side}
        for cache in (self.etags, self.trackers, self.risk_assessments, self.pending):
            for source in cache.keys() - active.keys():
                del cache[source]
        for source, frame_id in active.items():
            if frame_id is None or self.etags.get(source) != f'"{frame_id}"':
                self.process_frame(source)

    def process_frame(self, source):
        params = {"source_id": source, "camera_id": self.side}
        headers = {"If-None-Match": self.etags[source]} if source in self.etags else {}
        frame = self.http.get(self.api + "/frame", params=params, headers=headers, timeout=3)
        if frame.status_code in (204, 304, 404):
            return
        frame.raise_for_status()
        # The phone may upload again between discovery, this GET and publication.
        # Only the ETag on these JPEG bytes identifies the image we will process.
        etag = frame.headers["ETag"]
        pending = self.pending.get(source)
        if pending and pending[0] == etag:
            payload = pending[1]
        else:
            try:
                with Image.open(io.BytesIO(frame.content)) as jpeg:
                    image = ImageOps.exif_transpose(jpeg).convert("RGB")
            except (OSError, Image.DecompressionBombError) as error:
                self.etags[source] = etag
                print(f"Skipping unreadable Camera {self.side} frame: {error}", file=sys.stderr)
                return

            objects = self.infer(image) if self.infer else detect(self.model, image)
            payload = {"frame_id": etag.strip('"'), "objects": objects}
            if self.stereo is not None and self.side == "A":
                payload["stereo"] = self.measure_depth(params, payload, image)
            stream = frame.headers.get("X-CV-Stream-Id")
            frame_stamp = frame.headers.get("X-CV-Frame-Ms")
            stamp = int(frame_stamp) if frame_stamp is not None else None
            if stream and stamp is not None:  # Older servers can still consume untracked detections.
                tracker = self.trackers.get(source)
                if tracker is None or tracker.stream_id != stream:
                    tracker = self.trackers[source] = FrameTracker(stream, self.side, self.ids)
                    self.risk_assessments[source] = RiskAssessment()
                tracker.update(objects, stamp)
            for obj in objects:
                obj["obstacle_candidate"] = is_obstacle_candidate(obj["bbox"])
            if stream and stamp is not None:
                self.risk_assessments[source].update(objects, stamp)
            else:
                for obj in objects:
                    obj["risk"] = "normal"
            items = [obj for obj in objects if obj["label"] != "person" and obj["confidence"] >= 0.5]
            if items:
                bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
                for obj, feature in zip(items, item_features(bgr, [obj["bbox"] for obj in items])):
                    if feature:
                        obj["item_feature"] = feature
            if stamp is not None:
                payload.update(schema_version=1, camera_id=self.side, timestamp_ms=stamp)
            self.pending[source] = (etag, payload)
        result = self.http.post(self.api + "/detections", params=params, timeout=3, json=payload)
        if result.status_code not in (404, 409):
            result.raise_for_status()
            if self.record and "X-CV-Accepted-Ms" in result.headers:
                self.record(self.side, source, etag.strip('"'), int(result.headers["X-CV-Accepted-Ms"]),
                            int(result.headers["X-CV-Latency-Ms"]))
        # Accepted or obsolete. A transient transport/server failure above leaves
        # this ETag eligible for retry if the same JPEG is still available.
        self.etags[source] = etag
        del self.pending[source]

    def measure_depth(self, params, payload, image):
        if image.size != self.stereo.size:
            return {"status": "size_mismatch"}
        query = {**params, "frame_id": payload["frame_id"], "max_skew_ms": self.stereo.skew_ms}
        partner = self.http.get(self.api + "/stereo-partner", params=query, timeout=3)
        if partner.status_code in (204, 404):
            return {"status": "waiting_for_pair"}
        partner.raise_for_status()
        right = cv2.imdecode(np.frombuffer(partner.content, np.uint8), cv2.IMREAD_GRAYSCALE)
        if right is None or right.shape != self.stereo.size[::-1]:
            return {"status": "size_mismatch"}
        depth = self.stereo.compute(np.asarray(image.convert("L")), right)
        for obj in payload["objects"]:
            z = object_depth(depth, obj["bbox"])
            if z is not None:
                obj["depth_m"] = z
        if not np.isfinite(depth).any():
            return {"status": "no_matches"}
        preview = self.stereo.preview(depth)
        scale = min(1, 240 / max(preview.shape))
        thumb = cv2.resize(preview, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        ok, png = cv2.imencode(".png", thumb)
        if not ok:
            raise RuntimeError("Cannot encode depth preview")
        return {"status": "ready", "partner_id": partner.headers["X-Partner-Id"],
                "preview": base64.b64encode(png).decode("ascii")}


# Existing single-camera callers can keep their original constructor.
CameraAWorker = CameraWorker


def watch(worker, stop, interval):
    last_error = None
    while not stop.is_set():
        try:
            worker.poll()
            last_error = None
            stop.wait(interval)
        except requests.RequestException as error:
            message = str(error)
            if message != last_error:
                print(f"Camera {worker.side} connection failed; retrying: {message}", file=sys.stderr)
            last_error = message
            stop.wait(1)


def resolve_device(requested):
    import torch

    if requested == "auto":
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    if requested == "cpu":
        return requested
    if requested == "cuda":
        requested = "cuda:0"
    kind, _, index = requested.partition(":")
    if kind == "cuda" and index.isascii() and index.isdecimal() and int(index) < torch.cuda.device_count():
        return f"cuda:{int(index)}"
    raise ValueError(f"Unavailable inference device {requested!r}. Use cpu or an available CUDA device.")


def inference_options(parser):
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, or cuda:N")
    parser.add_argument("--imgsz", type=int, default=640, help="YOLO input size, a multiple of 32")
    parser.add_argument("--half", action="store_true", help="Opt in to FP16 on CUDA")
    parser.add_argument("--cpu-threads", type=int, default=1, help="PyTorch intra-op threads per CPU inference")
    parser.add_argument("--poll-ms", type=int, default=50, help="Milliseconds between discovery polls")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8765",
                        help="VisionAssist server URL on this computer")
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--stereo-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--metrics", type=Path, help="New CSV file for accepted frames from both cameras")
    inference_options(parser)
    args = parser.parse_args()
    try:
        stereo = StereoDepth.load(args.stereo_config)
    except (KeyError, OSError, ValueError, TypeError, cv2.error) as error:
        parser.error(f"Invalid stereo configuration {args.stereo_config}: {error}")
    if not args.weights.is_file():
        parser.error(f"Missing local weights: {args.weights}. See cv/README.md for setup.")

    if args.imgsz < 32 or args.imgsz % 32 or args.cpu_threads < 1 or args.poll_ms < 1:
        parser.error("Use a positive multiple of 32 for --imgsz and positive thread/poll values.")
    try:
        device = resolve_device(args.device)
    except ValueError as error:
        parser.error(str(error))
    if args.half and device == "cpu":
        parser.error("--half requires CUDA.")

    import torch
    from ultralytics import YOLO

    if device == "cpu":
        torch.set_num_threads(args.cpu_threads)
    cv2.setNumThreads(1)
    options = dict(device=torch.device(device), imgsz=args.imgsz, half=args.half)
    if device == "cpu":
        # Independent predictors let both camera threads use the CPU concurrently.
        predictors = [partial(detect, YOLO(str(args.weights), task="detect"), **options) for _ in "AB"]
    else:
        # Ultralytics predictors hold mutable state. Serialize only inference on
        # one resident GPU model; frame fetch and publication stay independent.
        predictor = partial(detect, YOLO(str(args.weights), task="detect"), **options)
        inference_lock = Lock()

        def infer(image):
            with inference_lock:
                return predictor(image)

        predictors = [infer, infer]

    stop = Event()
    with ExitStack() as stack:
        record = None
        if args.metrics:
            output = stack.enter_context(args.metrics.open("x", newline="", encoding="utf-8"))
            writer = csv.writer(output)
            writer.writerow(["camera", "source_id", "frame_id", "accepted_ms", "latency_ms"])
            output.flush()
            lock = Lock()

            def record(*row):
                with lock:
                    writer.writerow(row)
                    output.flush()

        workers = [
            CameraWorker(args.server, None, stack.enter_context(requests.Session()), side, record,
                         stereo=stereo if side == "A" else None, infer=infer)
            for side, infer in zip("AB", predictors)
        ]
        with ThreadPoolExecutor(max_workers=2) as pool:
            print(f"YOLO loaded. Watching cameras A and B on {device} at {args.server}. Ctrl+C to stop.", flush=True)
            try:
                futures = [pool.submit(watch, worker, stop, args.poll_ms / 1000) for worker in workers]
                for future in as_completed(futures):
                    future.result()
            except KeyboardInterrupt:
                pass
            finally:
                stop.set()


if __name__ == "__main__":
    main()
