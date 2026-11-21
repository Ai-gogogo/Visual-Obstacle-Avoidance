"""Exercise the live Camera A worker's outgoing payload over consecutive frames."""
import io
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
from PIL import Image

from live_camera import CameraWorker
from obstacles import PlaneObstacles
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
