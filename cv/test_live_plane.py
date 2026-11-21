"""Exercise the live Camera A worker's outgoing payload over consecutive frames."""
import io
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

from geometry import ground_axes, pitch_normal
from live_camera import CameraWorker
from obstacles import PlaneObstacles
from path_intrusion import Corridor
from plane_ransac import fit_support_plane
from road_edge import DEFAULT_ROAD_CONFIG
from stereo_depth import object_depth
from test_plane_ransac import scene


class LivePlaneTests(unittest.TestCase):
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
        segmenter = Mock(return_value=(np.zeros_like(candidate), candidate))
        road = Mock()
        road.segment = segmenter
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
        road.segment.return_value = np.zeros_like(candidate), candidate
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
