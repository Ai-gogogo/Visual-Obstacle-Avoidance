
"""Detect on Camera A and use Camera B for optional stereo depth."""
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
from path_intrusion import Corridor, IntrusionPredictor
from risk import RiskAssessment
from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge
from scene_segmentation import DEFAULT_SCENE_MODEL, SceneSampler, SceneSegmenter
from tracking import FrameTracker
from stereo_depth import DEFAULT_CONFIG, StereoDepth, object_depth


class CameraWorker:
    def __init__(
        self, server, model, session, side="A",
        record=None, stereo=None, *, infer=None,
        item_encoder=None, road=None, corridor=None, scene_sampler=None
    ):
        self.side = side
        self.stereo = stereo
        self.road = road
        self.scene_sampler = scene_sampler
        self.corridor = corridor
        self.intrusions = {}
        self.record = record
        self.api = server.rstrip("/") + "/api/cv"
        self.model = model
        self.infer = infer
        self.http = session

        # Optional SigLIP2 encoder; None keeps HSV.
        self.item_encoder = item_encoder

        self.etags = {}
        self.trackers = {}
        self.risk_assessments = {}
        self.pending = {}
        self.ids = count(1)

    def poll(self):
        sources = self.http.get(self.api + "/sources", timeout=3)
        sources.raise_for_status()
        active = {
            s["source_id"]: s.get("frame_id")
            for s in sources.json()["sources"]
            if s["camera_id"] == self.side
        }
        for cache in (
            self.etags, self.trackers,
            self.risk_assessments, self.intrusions, self.pending
        ):
            for source in cache.keys() - active.keys():
                del cache[source]
        for source, frame_id in active.items():
            if frame_id is None or self.etags.get(source) != f'"{frame_id}"':
                self.process_frame(source)

    def process_frame(self, source):
        params = {"source_id": source, "camera_id": self.side}
        headers = (
            {"If-None-Match": self.etags[source]}
            if source in self.etags else {}
        )
        frame = self.http.get(
            self.api + "/frame",
            params=params,
            headers=headers,
            timeout=3
        )
        if frame.status_code in (204, 304, 404):
            return

        frame.raise_for_status()
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
                print(
                    f"Skipping unreadable Camera {self.side} frame: {error}",
                    file=sys.stderr
                )
                return

            if self.scene_sampler is not None:
                self.scene_sampler.offer(source, etag.strip('"'), image)
            candidates = (
                self.infer(image)
                if self.infer else detect(self.model, image, confidence=.25)
            )
            objects = [obj for obj in candidates if obj["confidence"] >= .4]
            payload = {
                "frame_id": etag.strip('"'),
                "objects": objects
            }

            depth = None
            if self.side == "A":
                if self.stereo is not None:
                    payload["stereo"], depth = self.measure_depth(params, payload, image)
                if self.road is not None:
                    payload["road_edge"] = self.road(image, depth)

            stream = frame.headers.get("X-CV-Stream-Id")
            frame_stamp = frame.headers.get("X-CV-Frame-Ms")
            stamp = int(frame_stamp) if frame_stamp is not None else None

            if stream and stamp is not None:
                tracker = self.trackers.get(source)
                if tracker is None or tracker.stream_id != stream:
                    tracker = self.trackers[source] = FrameTracker(
                        stream, self.side, self.ids
                    )
                    self.risk_assessments[source] = RiskAssessment()
                tracker.update(objects, stamp)
                candidates = [obj for obj in candidates if .25 <= obj["confidence"] < .4]
                weak = tracker.preview_continuations(candidates, stamp, {obj["track_id"] for obj in objects})
                if weak:
                    payload["preview_objects"] = weak
            right_stream = payload.get("stereo", {}).pop("partner_stream", None)
            capture_ms = frame.headers.get("X-CV-Sample-Ms")
            if self.corridor and depth is not None and stream and right_stream and capture_ms:
                pair = stream, right_stream
                if source not in self.intrusions or self.intrusions[source][0] != pair:
                    self.intrusions[source] = pair, IntrusionPredictor(self.stereo.camera_a, self.corridor)
                self.intrusions[source][1].update(np.asarray(image.convert("L")), depth, objects, int(capture_ms))
            else:
                self.intrusions.pop(source, None)

            for obj in objects:
                obj["obstacle_candidate"] = is_obstacle_candidate(
                    obj["bbox"]
                )

            if stream and stamp is not None:
                self.risk_assessments[source].update(objects, stamp)
            else:
                for obj in objects:
                    obj["risk"] = "normal"

            # Personal item feature extraction.
            items = [
                obj for obj in objects
                if obj["label"] != "person"
                and obj["confidence"] >= 0.5
            ]
            if items:
                bgr = cv2.cvtColor(
                    np.asarray(image), cv2.COLOR_RGB2BGR
                )
                boxes = [obj["bbox"] for obj in items]

                # New: SigLIP2 when enabled; otherwise original HSV.
                if self.item_encoder is None:
                    features = item_features(bgr, boxes)
                else:
                    features = self.item_encoder.extract_boxes(
                        bgr, boxes
                    )

                for obj, feature in zip(items, features):
                    if feature:
                        obj["item_feature"] = feature

                        print(
                            f"[SigLIP2] {obj['label']} "
                            f"version={feature['version']} "
                            f"dim={len(feature['vector'])} "
                            f"norm={np.linalg.norm(feature['vector']):.4f}",
                            flush=True
                        )

            if stamp is not None:
                payload.update(
                    schema_version=1,
                    camera_id=self.side,
                    timestamp_ms=stamp
                )

            self.pending[source] = (etag, payload)

        result = self.http.post(
            self.api + "/detections",
            params=params,
            timeout=3,
            json=payload
        )
        if result.status_code not in (404, 409):
            result.raise_for_status()
            if self.record and "X-CV-Accepted-Ms" in result.headers:
                self.record(
                    self.side,
                    source,
                    etag.strip('"'),
                    int(result.headers["X-CV-Accepted-Ms"]),
                    int(result.headers["X-CV-Latency-Ms"])
                )

        self.etags[source] = etag
        del self.pending[source]

    def measure_depth(self, params, payload, image):
        if image.size != self.stereo.size:
            return {"status": "size_mismatch"}, None

        query = {
            **params,
            "frame_id": payload["frame_id"],
            "max_skew_ms": self.stereo.skew_ms
        }
        partner = self.http.get(
            self.api + "/stereo-partner",
            params=query,
            timeout=3
        )
        if partner.status_code in (204, 404):
            return {"status": "waiting_for_pair"}, None

        partner.raise_for_status()
        right = cv2.imdecode(
            np.frombuffer(partner.content, np.uint8),
            cv2.IMREAD_GRAYSCALE
        )
        if right is None or right.shape != self.stereo.size[::-1]:
            return {"status": "size_mismatch"}, None

        depth = self.stereo.compute(
            np.asarray(image.convert("L")), right
        )
        for obj in payload["objects"]:
            z = object_depth(depth, obj["bbox"])
            if z is not None:
                obj["depth_m"] = z

        if not np.isfinite(depth).any():
            return {"status": "no_matches"}, None

        preview = self.stereo.preview(depth)
        scale = min(1, 240 / max(preview.shape))
        thumb = cv2.resize(
            preview, None,
            fx=scale, fy=scale,
            interpolation=cv2.INTER_NEAREST
        )
        ok, png = cv2.imencode(".png", thumb)
        if not ok:
            raise RuntimeError("Cannot encode depth preview")

        return {
            "status": "ready",
            "partner_id": partner.headers["X-Partner-Id"],
            "partner_stream": partner.headers.get("X-Partner-Stream"),
            "preview": base64.b64encode(png).decode("ascii")
        }, depth


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
                print(
                    f"Camera {worker.side} connection failed; "
                    f"retrying: {message}",
                    file=sys.stderr
                )
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
    if (
        kind == "cuda"
        and index.isascii()
        and index.isdecimal()
        and int(index) < torch.cuda.device_count()
    ):
        return f"cuda:{int(index)}"
    raise ValueError(
        f"Unavailable inference device {requested!r}. "
        "Use cpu or an available CUDA device."
    )


def inference_options(parser):
    parser.add_argument(
        "--device",
        default="auto",
        help="auto, cpu, cuda, or cuda:N"
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
        help="YOLO input size, a multiple of 32"
    )
    parser.add_argument(
        "--half",
        action="store_true",
        help="Opt in to FP16 on CUDA"
    )
    parser.add_argument(
        "--cpu-threads",
        type=int,
        default=1,
        help="PyTorch intra-op threads per CPU inference"
    )
    parser.add_argument(
        "--poll-ms",
        type=int,
        default=50,
        help="Milliseconds between discovery polls"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--server",
        default="http://127.0.0.1:8765",
        help="VisionAssist server URL on this computer"
    )
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--dual-yolo", action="store_true",
                        help="Also run independent YOLO on Camera B")
    parser.add_argument(
        "--stereo-config", type=Path, default=DEFAULT_CONFIG
    )
    parser.add_argument(
        "--metrics",
        type=Path,
        help="New CSV file for accepted frames from both cameras"
    )

    # New option. HSV stays the default.
    parser.add_argument(
        "--item-encoder",
        choices=["hsv", "siglip2"],
        default="hsv",
        help="Personal item feature extractor"
    )

    parser.add_argument("--road-alerts", action="store_true", help="Enable sidewalk-to-road warnings on Camera A")
    parser.add_argument("--road-config", type=Path, default=DEFAULT_ROAD_CONFIG)
    parser.add_argument("--scene-segmentation", action="store_true",
                        help="Show indoor/outdoor ADE20K masks for Camera A")
    parser.add_argument("--scene-fps", type=float, default=3,
                        help="Maximum background segmentation rate (default: 3 frames/s)")
    inference_options(parser)
    args = parser.parse_args()

    try:
        stereo = StereoDepth.load(args.stereo_config)
    except (
        KeyError, OSError, ValueError,
        TypeError, cv2.error
    ) as error:
        parser.error(
            f"Invalid stereo configuration "
            f"{args.stereo_config}: {error}"
        )

    try:
        corridor = Corridor.load(args.road_config) if stereo is not None else None
        road = RoadEdge.load(args.road_config, stereo) if args.road_alerts else None
    except (ImportError, KeyError, OSError, ValueError, TypeError, RuntimeError) as error:
        parser.error(f"Invalid path warning configuration: {error}")

    if not args.weights.is_file():
        parser.error(
            f"Missing local weights: {args.weights}. "
            "See cv/README.md for setup."
        )

    if (
        args.imgsz < 32 or args.imgsz % 32
        or args.cpu_threads < 1 or args.poll_ms < 1
    ):
        parser.error(
            "Use a positive multiple of 32 for --imgsz "
            "and positive thread/poll values."
        )

    if not np.isfinite(args.scene_fps) or args.scene_fps <= 0:
        parser.error("--scene-fps must be positive and finite")

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

    # Load one shared SigLIP2 model, if requested.
    item_encoder = None
    if args.item_encoder == "siglip2":
        from siglip_features import SigLIPExtractor
        item_encoder = SigLIPExtractor()

    options = dict(
        device=torch.device(device),
        imgsz=args.imgsz,
        half=args.half,
        confidence=.25
    )

    sides = "AB" if args.dual_yolo else "A"
    if device == "cpu" or not args.dual_yolo:
        predictors = [
            partial(
                detect,
                YOLO(str(args.weights), task="detect"),
                **options
            )
            for _ in sides
        ]
    else:
        predictor = partial(
            detect,
            YOLO(str(args.weights), task="detect"),
            **options
        )
        inference_lock = Lock()

        def infer(image):
            with inference_lock:
                return predictor(image)

        predictors = [infer, infer]

    stop = Event()
    with ExitStack() as stack:
        record = None
        scene_sampler = None
        if args.scene_segmentation:
            try:
                scene_model = SceneSegmenter(DEFAULT_SCENE_MODEL)
            except (ImportError, OSError, ValueError, RuntimeError) as error:
                parser.error(str(error))
            scene_sampler = SceneSampler(scene_model, args.server.rstrip("/") + "/api/cv", args.scene_fps)
            scene_sampler.thread.start()
            stack.callback(scene_sampler.close)

        if args.metrics:
            output = stack.enter_context(
                args.metrics.open(
                    "x", newline="", encoding="utf-8"
                )
            )
            writer = csv.writer(output)
            writer.writerow([
                "camera", "source_id", "frame_id",
                "accepted_ms", "latency_ms"
            ])
            output.flush()
            lock = Lock()

            def record(*row):
                with lock:
                    writer.writerow(row)
                    output.flush()

        workers = [
            CameraWorker(
                args.server,
                None,
                stack.enter_context(requests.Session()),
                side,
                record,
                stereo=stereo if side == "A" else None,
                infer=infer,
                item_encoder=item_encoder,
                road=road if side == "A" else None,
                corridor=corridor if side == "A" else None,
                scene_sampler=scene_sampler if side == "A" else None
            )
            for side, infer in zip(sides, predictors)
        ]

        with ThreadPoolExecutor(max_workers=len(workers)) as pool:
            print(
                f"YOLO loaded for {sides} "
                f"on {device} at {args.server}. "
                f"Item encoder: {args.item_encoder}. "
                "Ctrl+C to stop.",
                flush=True
            )
            try:
                futures = [
                    pool.submit(
                        watch, worker, stop, args.poll_ms / 1000
                    )
                    for worker in workers
                ]
                for future in as_completed(futures):
                    future.result()
            except KeyboardInterrupt:
                pass
            finally:
                stop.set()


if __name__ == "__main__":
    main()
