"""Publish live Camera A and B detections to the local VisionAssist server."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack
import csv
import io
import sys
from itertools import count
from pathlib import Path
from threading import Event, Lock

import requests
from PIL import Image, ImageOps

import cv2
import numpy as np

from detect_image import DEFAULT_WEIGHTS, detect
from item_features import item_features
from obstacles import is_obstacle_candidate
from risk import RiskAssessment
from tracking import FrameTracker


class CameraWorker:
    def __init__(self, server, model, session, side="A", record=None):
        self.side = side
        self.record = record
        self.api = server.rstrip("/") + "/api/cv"
        self.model = model
        self.http = session
        self.etags = {}
        self.trackers = {}
        self.risk_assessments = {}
        self.pending = {}  # Preserve the exact payload when a POST acknowledgment is lost.
        self.ids = count(1)

    def poll(self):
        sources = self.http.get(self.api + "/sources", timeout=3)
        sources.raise_for_status()
        active = {s["source_id"] for s in sources.json()["sources"] if s["camera_id"] == self.side}
        for cache in (self.etags, self.trackers, self.risk_assessments, self.pending):
            for source in cache.keys() - active:
                del cache[source]
        for source in active:
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
            objects = pending[1]
        else:
            try:
                with Image.open(io.BytesIO(frame.content)) as jpeg:
                    image = ImageOps.exif_transpose(jpeg).convert("RGB")
            except (OSError, Image.DecompressionBombError) as error:
                self.etags[source] = etag
                print(f"Skipping unreadable Camera {self.side} frame: {error}", file=sys.stderr)
                return

            objects = detect(self.model, image)
            stream = frame.headers.get("X-CV-Stream-Id")
            if stream:  # Older servers can still consume untracked detections.
                tracker = self.trackers.get(source)
                if tracker is None or tracker.stream_id != stream:
                    tracker = self.trackers[source] = FrameTracker(stream, self.side, self.ids)
                    self.risk_assessments[source] = RiskAssessment()
                stamp = int(frame.headers["X-CV-Frame-Ms"])
                tracker.update(objects, stamp)
            for obj in objects:
                obj["obstacle_candidate"] = is_obstacle_candidate(obj["bbox"])
            if stream:
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
            self.pending[source] = (etag, objects)
        result = self.http.post(self.api + "/detections", params=params, timeout=3,
                                json={"frame_id": etag.strip('"'), "objects": objects})
        if result.status_code not in (404, 409):
            result.raise_for_status()
            if self.record and "X-CV-Accepted-Ms" in result.headers:
                self.record(self.side, source, etag.strip('"'), int(result.headers["X-CV-Accepted-Ms"]),
                            int(result.headers["X-CV-Latency-Ms"]))
        # Accepted or obsolete. A transient transport/server failure above leaves
        # this ETag eligible for retry if the same JPEG is still available.
        self.etags[source] = etag
        del self.pending[source]


# Existing single-camera callers can keep their original constructor.
CameraAWorker = CameraWorker


def watch(worker, stop):
    last_error = None
    while not stop.is_set():
        try:
            worker.poll()
            last_error = None
            stop.wait(0.15)
        except requests.RequestException as error:
            message = str(error)
            if message != last_error:
                print(f"Camera {worker.side} connection failed; retrying: {message}", file=sys.stderr)
            last_error = message
            stop.wait(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8765",
                        help="VisionAssist server URL on this computer")
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--metrics", type=Path, help="New CSV file for accepted frames from both cameras")
    args = parser.parse_args()
    if not args.weights.is_file():
        parser.error(f"Missing local weights: {args.weights}. See cv/README.md for setup.")

    from ultralytics import YOLO

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

        # Each inference loop owns its own predictor, HTTP session and ETag cache.
        workers = [CameraWorker(args.server, YOLO(str(args.weights), task="detect"),
                                stack.enter_context(requests.Session()), side, record) for side in "AB"]
        with ThreadPoolExecutor(max_workers=2) as pool:
            print(f"YOLO loaded. Watching cameras A and B at {args.server}. Ctrl+C to stop.", flush=True)
            try:
                futures = [pool.submit(watch, worker, stop) for worker in workers]
                for future in as_completed(futures):
                    future.result()
            except KeyboardInterrupt:
                pass
            finally:
                stop.set()


if __name__ == "__main__":
    main()
