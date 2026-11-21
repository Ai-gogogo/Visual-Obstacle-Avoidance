"""Exercise the live Camera A worker's outgoing payload over consecutive frames."""
import base64
import io
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import cv2
import numpy as np
from PIL import Image

from geometry import ground_axes, pitch_normal
from live_camera import CameraWorker
from obstacles import PlaneObstacles
from path_intrusion import Corridor
from plane_ransac import fit_support_plane
from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge, RoadSegmenter
from stereo_depth import object_depth
from test_plane_ransac import scene


class LivePlaneTests(unittest.TestCase):
    def test_road_and_plane_share_one_cityscapes_inference_without_sending_the_map(self):
        depth, camera, support, _, _, projection = scene(noisy=False)
        wall = np.s_[400:420, 225:250]
        depth[wall] = (.18 - .55) / projection[wall]
        model = RoadSegmenter.__new__(RoadSegmenter)
        model.session = Mock()
        logits = np.zeros((1, 19, 128, 96), dtype=np.float32)
        logits[0, 3, :85] = 10
        logits[0, 1, 93:] = 10
        model.session.run.return_value = [logits]
        stereo = SimpleNamespace(camera_a=camera, size=(480, 640))
        road = RoadEdge(json.loads(DEFAULT_ROAD_CONFIG.read_text()), stereo, model)
        jpeg = io.BytesIO()
        Image.new("RGB", stereo.size).save(jpeg, format="JPEG")
        http = Mock()
        http.get.return_value = Mock(status_code=200, content=jpeg.getvalue(), headers={"ETag": '"id"'})
        http.post.return_value.status_code = 204

        def process(road_module, plane_settings, raw_depth, calls):
            model.session.run.reset_mock()
            worker = CameraWorker("http://local", None, http, stereo=stereo, road=road_module,
                                  plane=plane_settings, infer=lambda _: [])
            worker.measure_depth = Mock(return_value=({}, raw_depth))
            worker.process_frame("source")
            self.assertEqual(model.session.run.call_count, calls)
            payload = http.post.call_args.kwargs["json"]
            self.assertNotIn("semantic_map", json.dumps(payload))
            return payload

        settings = PlaneObstacles()
        both = process(road, settings, depth, 1)
        self.assertTrue(both["stereo"]["plane"]["validated"])
        self.assertEqual(len(both["unclassified_obstacles"]), 1)
        wall_record = both["unclassified_obstacles"][0]
        self.assertEqual((wall_record["semantic_label"], wall_record["semantic_confidence"]), ("wall", 1.0))
        without_road = process(None, settings, depth, 0)
        self.assertNotIn("semantic_label", without_road["unclassified_obstacles"][0])
        self.assertIn("road_edge", process(road, None, depth, 1))
        self.assertIn("road_edge", process(road, settings, None, 1))

    def test_segmented_foreground_shared_by_pose_fit_and_unknown_obstacle_deduplication(self):
        depth, camera, support, _, _, _ = scene(noisy=False)
        chair = dict(label="chair", bbox=[.25, .65, .50, .90], confidence=.9, position="center")
        table = dict(label="dining table", bbox=[.70, .65, .90, .90], confidence=.9, position="right")
        silhouette = np.zeros(depth.shape, bool)
        silhouette[420:572, 120:133] = True
        silhouette[420:572, 225:240] = True
        tabletop = np.zeros_like(silhouette)
        tabletop[420:572, 336:432] = True
        jpeg = io.BytesIO()
        Image.new("RGB", (480, 640)).save(jpeg, format="JPEG")
        http = Mock()
        http.post.return_value.status_code = 204
        worker = CameraWorker("http://local", None, http, stereo=SimpleNamespace(camera_a=camera),
                              plane=PlaneObstacles())
        worker.measure_depth = Mock(side_effect=lambda *_: ({"partner_stream": "B"}, depth))
        plane = fit_support_plane(depth, camera, support)
        self.assertTrue(plane.validated)
        for i, masks in enumerate((None, [silhouette, tabletop]), 1):
            worker.infer = lambda _: ([chair.copy(), table.copy()], masks)
            http.get.return_value = Mock(status_code=200, content=jpeg.getvalue(), headers={
                "ETag": f'"{i}"', "X-CV-Stream-Id": "A", "X-CV-Frame-Ms": str(i*100),
                "X-CV-Sample-Ms": str(i*100),
            })
            with (patch("live_camera.fit_support_plane", return_value=plane) as fit,
                  patch("live_camera.pose_between", return_value=None),
                  patch("live_camera.unclassified_obstacles", return_value=[]) as dedup):
                worker.process_frame("source")
            fit_mask = fit.call_args.args[2]
            background = dedup.call_args.args[3]
            pnp = worker.plane_frames["source"].frame.background
            for region in (fit_mask, background, pnp):
                self.assertFalse(region[500, 135])
                self.assertEqual(bool(region[500, 180]), masks is not None)
            self.assertTrue(fit_mask[500, 380])
            self.assertTrue(background[500, 380])
            self.assertEqual(bool(pnp[500, 380]), masks is not None)
            self.assertIs(fit.call_args.args[0], depth)
            self.assertIs(dedup.call_args.args[0], depth)
            json_payload = http.post.call_args.kwargs["json"]
            self.assertTrue(all("mask" not in obj for obj in json_payload["objects"]))

    def test_config_opt_in(self):
        path = Path(__file__).with_name("road_config.json")
        self.assertIsNone(PlaneObstacles.load(path))
        self.assertEqual(PlaneObstacles.load(path, force=True), PlaneObstacles())

    def test_valid_plane_and_same_stream_fallback(self):
        depth, camera, candidate, held, _, projection = scene(noisy=False)
        bump = np.s_[565:581, 233:250]
        depth[bump] = (.18 - .55) / projection[bump]
        outside = np.s_[370:389, 460:480]
        speck = np.s_[590:592, 240:242]
        for region in (outside, speck):
            depth[region] = (.12 - .55) / projection[region]
        raised = np.s_[506:560, 182:222]
        depth[raised] = (.14 - .55) / projection[raised]
        bad = depth.copy()
        bad[held & candidate] += .09 / projection[held & candidate]
        objects = [
            dict(label="person", confidence=.9, position="center", relative_depth="near",
                 bbox=[182/480, 506/640, 222/480, 560/640]),
            dict(label="person", confidence=.9, position="center", relative_depth="near",
                 bbox=[275/480, 510/640, 308/480, 560/640]),
        ]
        segmenter = Mock(return_value=(np.zeros_like(candidate), candidate, np.full(depth.shape, 255, np.uint8)))
        road = Mock()
        road.segment_scene = segmenter
        road.confidence = .55
        road.locate.return_value = {"risk": "normal"}
        road.return_value = {"risk": "normal"}
        jpeg = io.BytesIO()
        Image.new("RGB", (480, 640)).save(jpeg, format="JPEG")
        fake = Mock()
        fake.post.return_value.status_code = 204
        worker = CameraWorker("http://local", None, fake, stereo=SimpleNamespace(camera_a=camera),
                              infer=lambda _: [dict(obj) for obj in objects], plane=PlaneObstacles(), road=road)
        fallback = CameraWorker("http://local", None, fake, stereo=worker.stereo, infer=worker.infer, road=road)

        def process(worker, i, current):
            fake.get.return_value = Mock(status_code=200, content=jpeg.getvalue(), headers={
                "ETag": f'"{i}"', "X-CV-Stream-Id": "camera-a", "X-CV-Frame-Ms": str(i * 100),
            })

            def measure(_, payload, *_args):
                if current is None:
                    return {"status": "waiting_for_pair"}, None
                for obj in payload["objects"]:
                    obj["depth_m"] = object_depth(current, obj["bbox"])
                return {"status": "ready", "preview": "unchanged"}, current

            worker.measure_depth = measure
            worker.process_frame("source")
            return fake.post.call_args.kwargs["json"]

        def decisions(result):
            return [(obj["obstacle_candidate"], obj["risk"]) for obj in result["objects"]]

        for i, current in enumerate((depth, depth, bad, None, depth), 1):
            baseline, result = process(fallback, i, current), process(worker, i, current)
            self.assertNotIn("plane", baseline["stereo"])
            self.assertEqual(result["stereo"].get("preview"), baseline["stereo"].get("preview"))
            self.assertEqual(result["road_edge"], baseline["road_edge"])
            if i in (1, 2, 5):
                self.assertTrue(result["stereo"]["plane"]["validated"], result["stereo"]["plane"])
                self.assertEqual(decisions(result), [(True, "urgent" if i == 2 else "normal"), (False, "normal")])
                self.assertAlmostEqual(result["objects"][0]["height_above_plane_m"], .14, delta=.005)
                self.assertEqual(len(result["unclassified_obstacles"]), 1)
                self.assertAlmostEqual(result["unclassified_obstacles"][0]["height_above_plane_m"], .18, delta=.005)
            else:
                self.assertFalse(result["stereo"]["plane"]["validated"])
                reason = "holdout_p90_exceeded" if current is not None else "depth_unavailable"
                self.assertEqual(result["stereo"]["plane"]["reason"], reason)
                self.assertEqual(decisions(result), decisions(baseline))
                self.assertNotIn("unclassified_obstacles", result)
                self.assertTrue(all("height_above_plane_m" not in obj for obj in result["objects"]))
        self.assertEqual(segmenter.call_count, 4)


    def test_wide_object_edge_and_finite_summary(self):
        depth, camera, candidate, _, _, _ = scene(noisy=False)
        plane = fit_support_plane(depth, camera, candidate)
        worker = CameraWorker("http://local", None, Mock(), stereo=SimpleNamespace(camera_a=camera),
                              plane=PlaneObstacles())
        payload = {"objects": [{"label": "chair", "bbox": [.59, .62, .98, .85],
                                "obstacle_candidate": False, "depth_m": 3.}]}
        with (patch("live_camera.fit_support_plane", return_value=plane),
              patch("live_camera.object_height_m", return_value={"median_m": .2}),
              patch("live_camera.unclassified_obstacles", return_value=[])):
            worker.apply_support_plane(payload, depth, candidate)
        self.assertTrue(payload["objects"][0]["obstacle_candidate"])
        summary = payload["stereo"]["plane"]
        self.assertEqual(summary["pitch_deg"], round(plane.pitch_deg, 4))
        self.assertEqual(summary["holdout_p90_m"], round(plane.holdout_p90_m, 4))
        with patch("live_camera.fit_support_plane") as fit:
            fit.return_value.validated = False
            fit.return_value.reason = "rejected"
            fit.return_value.pitch_deg = np.nan
            fit.return_value.roll_deg = np.inf
            fit.return_value.inlier_ratio = .123456
            fit.return_value.holdout_p90_m = None
            worker.apply_support_plane(payload, depth, candidate)
        self.assertEqual(payload["stereo"]["plane"],
                         {"validated": False, "reason": "rejected", "inlier_ratio": .1235})

    def test_pose_transports_orientation_and_falls_back_on_expiry_failure_or_repair(self):
        depth, camera, candidate, held, _, _ = scene(noisy=False)
        bad = depth.copy()
        bad[held & candidate] *= .65
        jpeg = io.BytesIO()
        Image.new("RGB", (480, 640)).save(jpeg, format="JPEG")
        road = Mock(confidence=.55)
        road.segment_scene.return_value = np.zeros_like(candidate), candidate, np.full(depth.shape, 255, np.uint8)
        road.locate.return_value = {"level": "visual"}
        http = Mock()
        http.post.return_value.status_code = 204
        worker = CameraWorker("http://local", None, http, stereo=SimpleNamespace(camera_a=camera),
                              plane=PlaneObstacles(), road=road, infer=lambda _: [],
                              corridor=Corridor.load(DEFAULT_ROAD_CONFIG))
        rotation = np.diag([1., np.cos(.04), np.cos(.04)])
        rotation[1, 2], rotation[2, 1] = -np.sin(.04), np.sin(.04)
        motion = (rotation, np.array([.01, 0., .02]))

        def step(stamp, raw_depth, pose, right="B"):
            http.get.return_value = Mock(status_code=200, content=jpeg.getvalue(), headers={
                "ETag": f'"{stamp}"', "X-CV-Stream-Id": "A", "X-CV-Frame-Ms": str(stamp),
                "X-CV-Sample-Ms": str(stamp),
            })
            worker.measure_depth = Mock(return_value=({"partner_stream": right, "meter_scale": 1.}, raw_depth))
            with patch("live_camera.pose_between", return_value=pose) as pnp:
                worker.process_frame("source")
            return road.locate.call_args.kwargs, http.post.call_args.kwargs["json"], pnp

        with patch("live_camera.IntrusionPredictor") as predictor:
            current, _, _ = step(1000, depth, None)
            carried, payload, pnp = step(1100, bad, motion)
            pnp.assert_called_once()
            update = predictor.return_value.update.call_args.kwargs
            self.assertIs(update["pose"], motion)
            self.assertIs(update["axes"], carried["axes"])
        self.assertFalse(payload["stereo"]["plane"]["validated"])
        self.assertIsNone(carried["plane"])
        expected = ground_axes(rotation @ current["plane"].normal)
        np.testing.assert_allclose(carried["axes"], expected)
        self.assertIsNone(step(1501, bad, motion)[0]["axes"])
        step(1601, depth, motion)
        self.assertIsNone(step(1701, bad, None)[0]["axes"])
        step(1801, depth, motion)
        repaired, _, pnp = step(1901, bad, motion, right="replacement B")
        pnp.assert_not_called()
        self.assertIsNone(repaired["axes"])

    def test_pitched_and_rolled_axes_are_orthogonal(self):
        normal = np.array([.17, -.93, -.32])
        normal /= np.linalg.norm(normal)
        forward, right = ground_axes(normal)
        matrix = np.stack([forward, right, normal])
        np.testing.assert_allclose(matrix @ matrix.T, np.eye(3), atol=1e-8)
        self.assertGreater(forward[2], 0.)
        self.assertGreater(right[0], 0.)
        default = PlaneObstacles(pitch_down_deg=20)
        points = np.array([[1., 2., 3.]])
        np.testing.assert_allclose(default.corridor_coordinates(points, None),
                                   default.corridor_coordinates(points, ground_axes(pitch_normal(np.radians(20)))))

    def test_debug_overlay_encodes_only_when_requested(self):
        depth, camera, candidate, _, _, projection = scene(noisy=False)
        bump = np.s_[547:585, 230:256]
        depth[bump] = (.16 - .55) / projection[bump]
        worker = CameraWorker("http://local", None, Mock(), stereo=SimpleNamespace(camera_a=camera),
                              plane=PlaneObstacles())
        with patch("live_camera.cv2.imencode", wraps=cv2.imencode) as encode:
            off = {"objects": []}
            worker.apply_support_plane(off, depth, candidate)
            encode.assert_not_called()
            self.assertNotIn("plane_overlay", off["stereo"])
            on = {"objects": []}
            worker.apply_support_plane(on, depth, candidate, overlay=True)
            encode.assert_called_once()
        pixels = cv2.imdecode(np.frombuffer(base64.b64decode(on["stereo"]["plane_overlay"]), np.uint8),
                              cv2.IMREAD_UNCHANGED)
        self.assertEqual(pixels.shape, (240, 180, 4))
        self.assertTrue(np.any(np.all(pixels == (0, 220, 70, 120), axis=-1)))
        self.assertTrue(np.any(np.all(pixels == (0, 135, 255, 165), axis=-1)))
        self.assertTrue(np.any(pixels[..., 3] == 0))
        rejected = {"objects": []}
        worker.apply_support_plane(rejected, np.full_like(depth, np.nan), candidate, overlay=True)
        self.assertFalse(rejected["stereo"]["plane"]["validated"])
        self.assertNotIn("plane_overlay", rejected["stereo"])

    def test_debug_overlay_limits_raised_height_and_colors_held_ground(self):
        worker = CameraWorker("http://local", None, Mock(), plane=PlaneObstacles())
        plane = SimpleNamespace(holdout_p90_m=.02)
        heights = np.full((8, 100), np.nan)
        candidate = np.ones(heights.shape, dtype=bool)
        heights[2, 10:14] = [.04, .05, 2.0, 2.01]
        heights[4, 49:52] = [.02, .03, .02]
        candidate[4, 51] = False

        with patch("live_camera.height_above_plane", return_value=heights):
            encoded = worker.encode_plane_overlay(np.empty_like(heights), None, plane, candidate)
        pixels = cv2.imdecode(np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_UNCHANGED)
        clear = (0, 0, 0, 0)
        orange = (0, 135, 255, 165)
        green = (0, 220, 70, 120)
        np.testing.assert_array_equal(pixels[2, 10:14], [clear, orange, orange, clear])
        np.testing.assert_array_equal(pixels[4, 49:52], [green, clear, clear])
