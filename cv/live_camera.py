"""Detect on Camera A and use a time-matched B frame for calibrated stereo depth."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack
import csv
from dataclasses import dataclass
import io
import os
import sys
import time
from functools import partial
from itertools import count
from pathlib import Path
from threading import Event, Lock

import cv2
import numpy as np
import requests
import raft_depth
from PIL import Image, ImageOps

from depth_filters import spatial_depth, StaticMedian
from detect_image import DEFAULT_WEIGHTS, detect
from geometry import deproject, ground_axes
from item_features import item_features
from mask_utils import InstanceMask
from obstacles import PlaneObstacles, is_obstacle_candidate, unclassified_obstacles
from path_intrusion import Corridor, Frame, IntrusionPredictor, background_mask, pose_between, support_background_mask
from plane_ransac import PlaneEstimate, fit_support_plane, height_above_plane, object_height_m, predict_plane
from risk import RiskAssessment
from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge
from scene_segmentation import DEFAULT_SCENE_MODEL, SceneSampler, SceneSegmenter
from tracking import FrameTracker
from stereo_depth import DEFAULT_CONFIG, StereoDepth, object_depth, object_depth_stats


@dataclass
class PlaneFrame:
    pair: tuple
    frame: Frame
    plane: PlaneEstimate | None
    accepted_stamp: int | None


class CameraWorker:
    def __init__(
        self, server, model, session, side="A",
        record=None, stereo=None, *, infer=None,
        item_encoder=None, road=None, corridor=None, allow_webrtc_stereo=False,
        inference_device=None, half=False, plane=None, scene_sampler=None
    ):
        self.side = side
        self.stereo = stereo
        self.original_stereo = stereo
        self.low_stereo = None
        self.rtc_low_stereo = None
        self.usb_resolution = None
        self.allow_webrtc_stereo = allow_webrtc_stereo
        self.rtc_reference = None
        self.verified_rtc_pair = None
        self.road = road
        self.scene_sampler = scene_sampler if side == "A" else None
        self.plane = plane if side == "A" else None
        self.corridor = corridor
        self.intrusions = {}
        self.plane_frames = {}
        self.record = record
        self.api = server.rstrip("/") + "/api/cv"
        self.model = model
        self.infer = infer
        self.http = session
        self.runtime_headers = {
            "X-CV-Camera": side,
            "X-CV-Device": inference_device,
            "X-CV-Precision": "fp16" if half else "fp32",
        } if inference_device else None

        # Optional SigLIP2 encoder; None keeps HSV.
        self.item_encoder = item_encoder

        self.etags = {}
        self.trackers = {}
        self.risk_assessments = {}
        self.temporal = {}
        self.pending = {}  # Preserve the exact payload when a POST acknowledgment is lost.
        self.ids = count(1)

    def poll(self):
        options = {"headers": self.runtime_headers} if self.runtime_headers else {}
        sources = self.http.get(self.api + "/sources", timeout=3, **options)
        sources.raise_for_status()
        active = {
            s["source_id"]: s.get("frame_id")
            for s in sources.json()["sources"]
            if s["camera_id"] == self.side
        }
        for cache in (
            self.etags, self.trackers,
            self.risk_assessments, self.intrusions, self.plane_frames, self.pending, self.temporal
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
        resolution = frame.headers.get("X-USB-Resolution")
        rtc_low = frame.headers.get("X-CV-Transport") == "webrtc" and frame.headers.get("X-RTC-Profile") == "portrait-low"
        if rtc_low and self.rtc_low_stereo is not None:
            self.stereo = self.rtc_low_stereo
        elif (resolution == "480x640" or rtc_low) and self.original_stereo and self.original_stereo.size == (1080, 1920):
            if self.low_stereo is None:
                self.low_stereo = self.original_stereo.for_usb_low_output()
            self.stereo = self.low_stereo
        else:
            self.stereo = self.original_stereo
        self.usb_resolution = resolution
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
            prediction = (
                self.infer(image)
                if self.infer else detect(self.model, image, confidence=.25, return_masks=True)
            )
            # Legacy injected predictors return only the object list.
            candidates, masks = prediction if isinstance(prediction, tuple) else (prediction, None)
            accepted = [i for i, obj in enumerate(candidates) if obj["confidence"] >= .4]
            objects = [candidates[i] for i in accepted]
            object_masks = None
            if masks is not None:
                object_masks = [InstanceMask(masks[i]) if masks[i] is not None else None for i in accepted]
            payload = {
                "frame_id": etag.strip('"'),
                "objects": objects
            }

            depth = None
            road_masks = None
            semantic_map = None
            if self.side == "A":
                if self.stereo is not None:
                    if frame.headers.get("X-CV-Transport") == "webrtc" and not self.allow_webrtc_stereo and not (rtc_low and (self.rtc_reference is not None or self.rtc_low_stereo is not None)):
                        payload["stereo"] = {"status": "transport_unvalidated"}
                    else:
                        retry_partner = rtc_low and "X-CV-Sample-Ms" in frame.headers
                        payload["stereo"], depth = self.measure_depth(params, payload, image, retry_partner, object_masks)
                if self.road is not None:
                    if self.plane is not None and depth is not None:
                        road, sidewalk, semantic_map = self.road.segment_scene(image)
                        road_masks = road, sidewalk
                    else:
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
            stereo_result = payload.get("stereo", {})
            right_stream = stereo_result.pop("partner_stream", None)
            meter_scale = stereo_result.pop("meter_scale", None)
            overlay = stereo_result.pop("plane_overlay_requested", False)
            capture_ms = frame.headers.get("X-CV-Sample-Ms")
            paired = depth is not None and stream and right_stream and capture_ms
            pair = (stream, right_stream, meter_scale, id(self.stereo))
            gray = np.asarray(image.convert("L")) if paired and (self.corridor or self.plane) else None

            for obj in objects:
                obj["obstacle_candidate"] = is_obstacle_candidate(obj["bbox"])

            metric_evidence = {}
            dynamic = {}
            precise_background = None
            if depth is not None and object_masks and any(mask is not None for mask in object_masks):
                if self.plane:
                    precise_background = support_background_mask(depth.shape, objects, masks=object_masks)
                elif self.corridor and paired:
                    precise_background = background_mask(depth.shape, objects, masks=object_masks)
            if self.plane:
                current = pose = prior = None
                if paired:
                    current, pose, prior = self.prepare_plane_frame(
                        source, pair, gray, depth, objects, int(capture_ms), background=precise_background)
                else:
                    self.plane_frames.pop(source, None)
                support = road_masks[0] | road_masks[1] if road_masks is not None else None
                metric_evidence, measured = self.apply_support_plane(payload, depth, support, masks=object_masks,
                                                                    prior=prior, overlay=overlay,
                                                                    background=precise_background,
                                                                    semantic_map=semantic_map)
                fresh = measured if measured is not None and measured.validated else None
                orientation = fresh or prior
                axes = ground_axes(orientation.normal) if orientation is not None else None
                dynamic = {"axes": axes, "pose": pose}
                if current is not None and fresh is not None:
                    current.plane = fresh
                    current.accepted_stamp = current.frame.stamp
                if road_masks is not None:
                    payload["road_edge"] = self.road.locate(
                        *road_masks, depth, axes=axes, plane=fresh, camera=self.stereo.camera_a)

            if self.corridor and paired:
                if precise_background is not None:
                    dynamic["background"] = precise_background
                if source not in self.intrusions or self.intrusions[source][0] != pair:
                    self.intrusions[source] = pair, IntrusionPredictor(self.stereo.camera_a, self.corridor)
                self.intrusions[source][1].update(gray, depth, objects, int(capture_ms), **dynamic)
            else:
                self.intrusions.pop(source, None)

            if stream and stamp is not None:
                self.risk_assessments[source].update(objects, stamp, metric_evidence=metric_evidence)
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
                    int(result.headers["X-CV-Latency-Ms"]),
                    result.headers.get("X-CV-Capture-Latency-Ms", "")
                )

        self.etags[source] = etag
        del self.pending[source]

    def prepare_plane_frame(self, source, pair, gray, depth, objects, stamp, *, background=None):
        if background is None:
            # Preserve the detection-only PnP mask, including its legacy table boxes.
            background = background_mask(gray.shape, objects)
        frame = Frame(gray, depth, background, stamp, {})
        current = PlaneFrame(pair, frame, None, None)
        previous = self.plane_frames.get(source)
        self.plane_frames[source] = current
        if previous is None or previous.pair != pair:
            return current, None, None
        pose = pose_between(previous.frame, frame, self.stereo.camera_a, self.plane.max_turn_rate)
        if (pose is not None and previous.plane is not None
                and 0 < stamp - previous.accepted_stamp <= self.plane.prior_max_age_ms):
            current.plane = predict_plane(previous.plane, *pose)
            if current.plane is not None:
                current.accepted_stamp = previous.accepted_stamp
        return current, pose, current.plane

    def apply_support_plane(self, payload, depth, support, *, masks=None, prior=None, overlay=False,
                            background=None, semantic_map=None):
        stereo = payload.setdefault("stereo", {})
        if depth is None:
            stereo["plane"] = {"validated": False, "reason": "depth_unavailable"}
            return {}, None

        objects = payload["objects"]
        h, w = depth.shape
        if background is None:
            background = support_background_mask(depth.shape, objects, masks=masks)
        background = background.astype(bool, copy=False)
        if support is None or not support.any():
            support = np.arange(h)[:, None] >= .45 * h
        camera = self.stereo.camera_a
        candidate = background & support
        plane = fit_support_plane(depth, camera, candidate, prior_plane=prior, config=self.plane.fit)
        summary = {"validated": plane.validated, "reason": plane.reason}
        for key in ("pitch_deg", "roll_deg", "inlier_ratio", "holdout_p90_m"):
            value = getattr(plane, key)
            if value is not None and np.isfinite(value):
                summary[key] = round(float(value), 4)
        stereo["plane"] = summary
        if not plane.validated:
            return {}, plane

        if overlay:
            encoded = self.encode_plane_overlay(depth, camera, plane, candidate)
            if encoded is not None:
                stereo["plane_overlay"] = encoded
        axes = ground_axes(plane.normal)
        metric_evidence = {}
        for index, obj in enumerate(objects):
            mask = masks[index] if masks is not None else None
            height = object_height_m(depth, camera, plane, obj["bbox"], mask=mask)
            if height is None:
                continue
            median = height["median_m"]
            obj["height_above_plane_m"] = round(median, 3)
            z = obj.get("depth_m")
            if z is None:
                continue
            left, top, right, bottom = np.asarray(obj["bbox"]) * [w, h, w, h]
            cy = (top + bottom) / 2
            xyz = deproject([(left, cy), ((left + right) / 2, cy), (right, cy)], z, camera)
            forward, lateral = self.plane.corridor_coordinates(xyz, axes)
            distance = forward[1]
            lo, hi = sorted(lateral[[0, 2]])
            inside = (lo <= self.plane.half_width_m and hi >= -self.plane.half_width_m
                      and 0 < distance <= self.plane.caution_m)
            metric_evidence[index] = obj["obstacle_candidate"], bool(distance <= self.plane.urgent_m)
            obj["obstacle_candidate"] = bool(inside and median >= self.plane.min_height_m)

        payload["unclassified_obstacles"] = unclassified_obstacles(
            depth, camera, plane, background, self.plane, axes, semantic_map=semantic_map)
        return metric_evidence, plane

    def encode_plane_overlay(self, depth, camera, plane, candidate):
        """Encode only when requested, using the same Camera A alignment as the depth map."""
        heights = height_above_plane(depth, camera, plane)
        width = depth.shape[1]
        x = np.arange(width)
        held = (x >= .44 * width) & (x < .56 * width)
        tolerance = self.plane.fit.inlier_tol_m
        ground_tolerance = np.where(held, self.plane.fit.holdout_p90_max_m, tolerance)
        inliers = candidate & (np.abs(heights) <= ground_tolerance)
        min_raised = max(self.plane.min_height_m, tolerance, plane.holdout_p90_m)
        raised = (heights >= min_raised) & (heights <= 2.0) & ~inliers
        scale = min(1, 240 / max(depth.shape))
        masks = [cv2.resize(mask.astype(np.uint8), None, fx=scale, fy=scale,
                            interpolation=cv2.INTER_NEAREST).astype(bool) for mask in (inliers, raised)]
        rgba = np.zeros((*masks[0].shape, 4), dtype=np.uint8)
        rgba[masks[0]] = (0, 220, 70, 120)
        rgba[masks[1]] = (0, 135, 255, 165)
        ok, png = cv2.imencode(".png", rgba)
        return base64.b64encode(png).decode("ascii") if ok else None

    def measure_depth(self, params, payload, image, retry_partner=False, masks=None):
        if image.size != self.stereo.size:
            return {"status": "size_mismatch"}, None

        query = {
            **params,
            "frame_id": payload["frame_id"],
            "max_skew_ms": self.stereo.skew_ms
        }
        try:
            partner = self.http.get(self.api + "/stereo-partner", params=query, timeout=.25)
            # B snapshots arrive about every 100 ms. Keep the same A frame
            # pinned while giving a slightly later B snapshot time to arrive.
            if retry_partner:
                for delay in (.05, .07, .08):
                    if partner.status_code != 204:
                        break
                    time.sleep(delay)
                    partner = self.http.get(self.api + "/stereo-partner", params=query, timeout=.25)
            if partner.status_code in (204, 404):
                return {"status": "waiting_for_pair"}, None
            partner.raise_for_status()
        except requests.RequestException:
            return {"status": "unavailable"}, None

        if self.usb_resolution and partner.headers.get("X-USB-Resolution") != self.usb_resolution:
            return {"status": "size_mismatch"}, None
        algorithm = partner.headers.get("X-Depth-Algorithm", "sgbm")
        right_input = cv2.imdecode(
            np.frombuffer(partner.content, np.uint8),
            cv2.IMREAD_COLOR if algorithm == "raft" else cv2.IMREAD_GRAYSCALE
        )
        if right_input is None or right_input.shape[:2] != self.stereo.size[::-1]:
            return {"status": "size_mismatch"}, None
        right = cv2.cvtColor(right_input, cv2.COLOR_BGR2GRAY) if algorithm == "raft" else right_input
        gray = np.asarray(image.convert("L"))
        if self.rtc_low_stereo is not None and self.stereo is self.rtc_low_stereo:
            if partner.headers.get("X-RTC-Profile") != "portrait-low":
                return {"status": "transport_unvalidated"}, None
        elif partner.headers.get("X-RTC-Profile") == "portrait-low" and not self.allow_webrtc_stereo:
            from rtc_geometry import same_view
            pair = (params["source_id"], partner.headers.get("X-Depth-Rig"))
            if self.verified_rtc_pair != pair:
                if not pair[1] or self.rtc_reference is None or not all(
                    same_view(reference, view) for reference, view in zip(self.rtc_reference, (gray, right))
                ):
                    return {"status": "transport_unvalidated"}, None
                self.verified_rtc_pair = pair
        low_crop = partner.headers.get("X-Depth-Low") == "1" and self.stereo.size == (1080, 1920)
        stereo = self.stereo
        views = (cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR), right_input) if algorithm == "raft" else (gray, right)
        if low_crop:
            if self.low_stereo is None:
                self.low_stereo = self.stereo.for_usb_low_output()
            stereo = self.low_stereo
            views = [cv2.resize(view[240:-240], (480, 640), interpolation=cv2.INTER_AREA) for view in views]
        if algorithm == "raft":
            try:
                depth = raft_depth.compute(stereo, *views)
            except (ImportError, OSError, RuntimeError) as error:
                if getattr(self, "raft_error", None) != str(error):
                    print(f"RAFT-Stereo unavailable: {error}", file=sys.stderr)
                self.raft_error = str(error)
                return {"status": "raft_unavailable"}, None
        else:
            depth = stereo.compute(*views)
        if low_crop:
            cropped = depth
            depth = np.full(gray.shape, np.nan, dtype=np.float32)
            depth[240:-240] = cv2.resize(cropped, (1080, 1440), interpolation=cv2.INTER_NEAREST)
        options = partner.headers
        source = params["source_id"]
        meters = options.get("X-Depth-Meters", "1") == "1"
        if self.stereo.square_units:
            five_mm = float(options.get("X-Depth-Five-Mm", 0))
            scale_m = five_mm / 5000 if np.isfinite(five_mm) and five_mm > 0 else None
        else:
            scale_m = 1.
        metric_depth = None
        if scale_m is not None:
            metric_depth = depth if scale_m == 1 else depth * scale_m
            for index, obj in enumerate(payload["objects"]):
                mask = masks[index] if masks is not None else None
                if mask is None:
                    # Preserve legacy grid-unit rounding and the detection-only JSON schema.
                    z = object_depth(depth, obj["bbox"])
                    if z is not None:
                        obj["depth_m"] = z * scale_m
                else:
                    stats = object_depth_stats(metric_depth, obj["bbox"], mask=mask)
                    if stats is not None:
                        obj["depth_m"] = stats["median_m"]
                        obj["nearest_depth_m"] = stats["nearest_m"]
        display = depth
        spatial = options.get("X-Depth-Spatial") == "1"
        if spatial:
            display = spatial_depth(depth, gray)
        if options.get("X-Depth-Temporal") == "1":
            key = (options.get("X-Depth-Rig"), spatial, low_crop, algorithm)
            display = self.temporal.setdefault(source, StaticMedian()).apply(
                key, int(options["X-Depth-Stamp"]), gray, display)
        else:
            self.temporal.pop(source, None)
        valid_fraction = np.count_nonzero(np.isfinite(depth)) / depth.size
        if not valid_fraction:
            return {"status": "no_matches"}, None
        preview = self.stereo.preview(display)
        scale = min(1, 240 / max(preview.shape))
        thumb = cv2.resize(
            preview, None,
            fx=scale, fy=scale,
            interpolation=cv2.INTER_NEAREST
        )
        ok, png = cv2.imencode(".png", thumb)
        if not ok:
            raise RuntimeError("Cannot encode depth preview")
        result = {"status": "ready", "algorithm": algorithm, "partner_id": options["X-Partner-Id"],
                  "preview": base64.b64encode(png).decode("ascii")}
        result.update(valid_fraction=valid_fraction, partner_stream=options.get("X-Partner-Stream"),
                      meter_scale=scale_m)
        if self.plane is not None and options.get("X-Depth-Plane-Overlay") == "1":
            result["plane_overlay_requested"] = True
        if meters and scale_m is not None:
            result["range_m"] = [self.stereo.min_m*scale_m, self.stereo.max_m*scale_m]
            # Report only original observations. Filters never create a metric reading.
            point = depth[depth.shape[0]//2, depth.shape[1]//2]
            if np.isfinite(point):
                result["center_m"] = float(point)*scale_m
        # Road and crossing warnings use unfiltered metric depth regardless of display settings.
        return result, metric_depth


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
        if torch.cuda.is_available():
            return "cuda:0"
        return "mps" if torch.backends.mps.is_available() else "cpu"
    if requested == "cpu" or (requested == "mps" and torch.backends.mps.is_available()):
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
        "Use cpu, mps on a supported Mac, or an available CUDA device."
    )


def inference_options(parser, *, default_cpu_threads=1):
    parser.add_argument("--device", default="auto",
                        help="auto (CUDA, then Apple MPS, then CPU), cpu, mps, cuda, or cuda:N")
    parser.add_argument("--imgsz", type=int, default=640, help="YOLO input size, a multiple of 32")
    parser.add_argument("--half", action="store_true", help="Opt in to FP16 on CUDA")
    parser.add_argument("--cpu-threads", type=int, default=default_cpu_threads,
                        help="PyTorch intra-op threads per CPU inference")
    parser.add_argument("--poll-ms", type=int, default=50, help="Milliseconds between discovery polls")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--server",
        default="http://127.0.0.1:8765",
        help="VisionAssist server URL on this computer"
    )
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--dual-yolo", action="store_true",
                        help="Also run independent YOLO on B (legacy dual-camera benchmark)")
    parser.add_argument("--stereo-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--usb-low-config", type=Path, help="Measured 480 × 640 calibration for this USB rig")
    parser.add_argument("--rtc-reference", type=Path, help="Static 480 × 640 USB landmarks from the calibrated rig")
    parser.add_argument("--rtc-low-config", type=Path, help="Measured 480 × 640 WebRTC calibration")
    parser.add_argument("--allow-webrtc-stereo", action="store_true",
                        help="Enable metric depth from verified WebRTC rig geometry")
    parser.add_argument("--metrics", type=Path, help="New CSV file for accepted frames from both cameras")
    # New option. HSV stays the default.
    parser.add_argument(
        "--item-encoder",
        choices=["hsv", "siglip2"],
        default="hsv",
        help="Personal item feature extractor"
    )

    parser.add_argument("--road-alerts", action="store_true", help="Enable sidewalk-to-road warnings on Camera A")
    parser.add_argument("--plane-ransac", action="store_true", help="Enable metric support plane on Camera A")
    parser.add_argument("--road-config", type=Path, default=DEFAULT_ROAD_CONFIG)
    parser.add_argument("--scene-segmentation", action="store_true",
                        help="Show indoor/outdoor ADE20K masks for Camera A")
    parser.add_argument("--scene-fps", type=float, default=3,
                        help="Maximum background segmentation rate (default: 3 frames/s)")
    inference_options(parser, default_cpu_threads=None)
    args = parser.parse_args()
    if args.cpu_threads is None:
        args.cpu_threads = 1 if args.dual_yolo else min(4, os.cpu_count() or 1)
    try:
        stereo = StereoDepth.load(args.stereo_config)
        low_stereo = StereoDepth.load(args.usb_low_config) if args.usb_low_config else None
        rtc_low_stereo = StereoDepth.load(args.rtc_low_config) if args.rtc_low_config else None
        if args.rtc_low_config and (not rtc_low_stereo or rtc_low_stereo.size != (480, 640)):
            raise ValueError("WebRTC portrait-low requires an enabled 480 × 640 calibration")
        if args.usb_low_config and (not low_stereo or low_stereo.size != (480, 640)
                                    or not stereo or stereo.size != (1080, 1920)):
            raise ValueError("USB profiles require enabled 1080 × 1920 and 480 × 640 calibrations")
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
        plane = PlaneObstacles.load(args.road_config, force=args.plane_ransac)
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

    if args.half and not device.startswith("cuda:"):
        parser.error("--half requires CUDA.")

    import torch
    from ultralytics import YOLO

    if device in ("cpu", "mps"):
        torch.set_num_threads(args.cpu_threads)
    cv2.setNumThreads(1)

    # Load one shared SigLIP2 model, if requested.
    item_encoder = None
    if args.item_encoder == "siglip2":
        from siglip_features import SigLIPExtractor
        item_encoder = SigLIPExtractor()

    options = dict(device=torch.device(device), imgsz=args.imgsz, half=args.half, confidence=.25, return_masks=True)
    sides = "AB" if args.dual_yolo else "A"
    if device == "cpu" or not args.dual_yolo:
        # Independent predictors let both camera threads use the CPU concurrently.
        predictors = [partial(detect, YOLO(str(args.weights)), **options) for _ in sides]
    else:
        predictor = partial(
            detect,
            YOLO(str(args.weights)),
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
                "accepted_ms", "latency_ms", "capture_latency_ms"
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
                allow_webrtc_stereo=args.allow_webrtc_stereo,
                inference_device=device,
                half=args.half,
                plane=plane,
                scene_sampler=scene_sampler
            )
            for side, infer in zip(sides, predictors)
        ]

        workers[0].low_stereo = low_stereo
        workers[0].rtc_low_stereo = rtc_low_stereo
        if args.rtc_reference:
            with np.load(args.rtc_reference, allow_pickle=False) as ref:
                workers[0].rtc_reference = [(ref[s+"xy"],ref[s+"desc"]) for s in "AB"]
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
