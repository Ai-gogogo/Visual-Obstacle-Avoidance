import base64
import json
import subprocess
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import requests

from live_camera import CameraWorker
from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge
from stereo_depth import DEFAULT_CONFIG, StereoDepth, object_depth


def configuration():
    config = json.loads(DEFAULT_CONFIG.read_text())
    camera = dict(fx=240, fy=240, cx=160, cy=96, distortion=[0]*5)
    config.update(enabled=True, image_size_px=[320, 192], baseline_m=.1,
                  camera_A=camera, camera_B=camera.copy(), rotation_A_to_B=np.eye(3).tolist(),
                  translation_direction_A_to_B=[-1, 0, 0], num_disparities=32, max_pair_skew_ms=60)
    return config


def plane(config, meters):
    # Project a fronto-parallel textured plane at known A-camera Z into camera B.
    a = np.random.default_rng(132).integers(0, 256, (192, 320), dtype=np.uint8)
    ka, kb = [np.array([[cam["fx"], 0, cam["cx"]], [0, cam["fy"], cam["cy"]], [0, 0, 1]])
              for cam in (config["camera_A"], config["camera_B"])]
    translation = config["baseline_m"] * np.array(config["translation_direction_A_to_B"])
    homography = kb @ (config["rotation_A_to_B"] + np.outer(translation, [0, 0, 1/meters])) @ np.linalg.inv(ka)
    return a, cv2.warpPerspective(a, homography, (320, 192))


class StereoTests(unittest.TestCase):
    def test_calibrated_depth_and_separate_surfaces(self):
        config = configuration()
        stereo = StereoDepth(config)
        a, b = plane(config, 1.5)
        _, distant = plane(config, 3)
        b[96:] = distant[96:]
        depth = stereo.compute(a, b)
        self.assertEqual(depth.dtype, np.float32)
        self.assertAlmostEqual(object_depth(depth, [.3, .1, .7, .4]), 1.5, delta=.04)
        self.assertAlmostEqual(object_depth(depth, [.3, .6, .7, .9]), 3, delta=.08)
        self.assertIsNone(object_depth(depth, [.3, .15, .7, .85]))
        self.assertTrue(np.isnan(depth[:, :10]).all())

    def test_small_disparities_near_both_image_edges(self):
        config = configuration()
        depth = StereoDepth(config).compute(*plane(config, 2.0))
        # Ground-truth disparity is 12 px. Both edge strips have real matches,
        # even though a full search of 32 disparities does not fit there.
        for edge in (depth[20:-20, 19:29], depth[20:-20, -16:-6]):
            valid = edge[np.isfinite(edge)]
            self.assertGreater(valid.size, .8 * edge.size)
            self.assertLess(np.percentile(np.abs(valid - 2.0), 95), .08)
        self.assertTrue(np.isnan(depth[:, :2]).all())
        self.assertTrue(np.isnan(depth[:, -2:]).all())

    def test_rotated_rig_different_intrinsics_and_raw_a_boxes(self):
        config = configuration()
        config["rotation_A_to_B"] = cv2.Rodrigues(np.array([.01, .035, -.016]))[0].tolist()
        config["camera_B"].update(fx=260, fy=251, cx=157, cy=99)
        stereo = StereoDepth(config)
        depth = stereo.compute(*plane(config, 2))
        self.assertAlmostEqual(object_depth(depth, [.55, .2, .85, .7]), 2, delta=.08)

    def test_no_measurement_when_untextured_or_size_changed(self):
        stereo = StereoDepth(configuration())
        blank = np.full((192, 320), 120, np.uint8)
        depth = stereo.compute(blank, blank)
        self.assertTrue(np.isnan(depth).all())
        self.assertFalse(stereo.preview(depth).any())
        with self.assertRaises(ValueError):
            stereo.compute(blank, blank.T)

    def test_reversed_cameras_and_missing_calibration(self):
        config = configuration()
        config["translation_direction_A_to_B"] = [1, 0, 0]
        with self.assertRaises(ValueError):
            StereoDepth(config)
        config["baseline_m"] = None
        with self.assertRaises(ValueError):
            StereoDepth(config)


class LiveStereoTests(unittest.TestCase):
    def test_worker_server_preview_and_degraded_pairs(self):
        command = """const s=require('./web/server.cjs').createServer({agent:{filename:':memory:'}});
                     s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"""
        server = subprocess.Popen(["node", "-e", command], stdout=subprocess.PIPE, text=True,
                                  cwd=Path(__file__).resolve().parents[1])
        self.addCleanup(server.stdout.close)
        self.addCleanup(server.wait, 5)
        self.addCleanup(server.terminate)
        base = "http://127.0.0.1:" + str(int(server.stdout.readline()))
        http = requests.Session()
        self.addCleanup(http.close)

        def request(method, path, token=None, **kwargs):
            headers = kwargs.pop("headers", {})
            if token:
                headers["Authorization"] = "Bearer " + token
            result = http.request(method, base+path, timeout=3, headers=headers, **kwargs)
            result.raise_for_status()
            return result

        desk = request("POST", "/api/session").json()["token"]
        request("GET", "/api/agent/alerts", desk)

        def pair(side):
            code = request("POST", "/api/pair/"+side, desk).json()["code"]
            return request("POST", "/api/join", json={"code": code}).json()["token"]

        a, b = pair("A"), pair("B")
        config = configuration()
        left, right = plane(config, 2)
        worker = CameraWorker(base, None, http, stereo=StereoDepth(config))
        road_mask = np.indices(left.shape)[0] < 140
        worker.road = RoadEdge(json.loads(DEFAULT_ROAD_CONFIG.read_text()), worker.stereo,
                               lambda image, confidence: (road_mask, ~road_mask))

        def upload(phone, image, stamp, lossless=False):
            headers = {"Content-Type": "image/png" if lossless else "image/jpeg"}
            if stamp is not None:
                headers.update({"X-Sample-Ms": str(stamp), "X-Clock-Error-Ms": "3"})
            frame = cv2.imencode(".png" if lossless else ".jpg", image)[1].tobytes()
            request("PUT", "/api/frame", phone, headers=headers, data=frame)
            return frame

        def read():
            example = dict(label="chair", confidence=.9, position="center", bbox=[.3,.2,.7,.8])
            with patch("live_camera.detect", return_value=[example]):
                worker.poll()
            return request("GET", "/api/preview/A", desk).json()

        now = int(time.time()*1000)
        upload(b, right, now-180)
        upload(a, left, now)
        self.assertEqual(read()["stereo_status"], "waiting_for_pair")
        upload(b, right, now, lossless=True)
        upload(b, right*0, now+160)  # The newer B frame is a worse match.
        original = upload(a, left, now+5, lossless=True)
        measured = read()
        self.assertEqual(base64.b64decode(measured["png"]), original)
        self.assertNotIn("jpeg", measured)
        self.assertEqual(measured["stereo_status"], "ready")
        self.assertGreater(measured["depth_valid_fraction"], .5)
        self.assertAlmostEqual(measured["objects"][0]["depth_m"], 2, delta=.05)
        png = np.frombuffer(base64.b64decode(measured["depth_preview"]), np.uint8)
        self.assertGreater(cv2.imdecode(png, cv2.IMREAD_GRAYSCALE).max(), 0)
        self.assertEqual(measured["road_edge"]["level"], "urgent")
        self.assertAlmostEqual(measured["road_edge"]["distance_m"], 2, delta=.05)
        time.sleep(.01)
        upload(a, left, now+8)
        read()
        worker.poll()  # An unchanged JPEG must not generate a second road alert.
        alerts = request("GET", "/api/agent/alerts", desk).json()["alerts"]
        road_alerts = [alert for alert in alerts if alert.get("kind") == "road_edge"]
        self.assertEqual(len(road_alerts), 1)
        self.assertEqual(road_alerts[0]["risk"], "urgent")
        ready_preview = request("GET", "/api/preview/A", desk)
        request("DELETE", "/api/frame", b)
        cleared = request("GET", "/api/preview/A", desk, headers={"If-None-Match": ready_preview.headers["ETag"]})
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(cleared.json()["frame_id"], ready_preview.json()["frame_id"])
        self.assertEqual(cleared.json()["stereo_status"], "waiting_for_pair")
        self.assertNotIn("depth_preview", cleared.json())
        self.assertNotIn("depth_valid_fraction", cleared.json())
        self.assertNotIn("depth_m", cleared.json()["objects"][0])
        upload(a, left, None)
        old_phone = read()
        self.assertNotIn("depth_m", old_phone["objects"][0])
        self.assertNotIn("depth_preview", old_phone)
        self.assertEqual(old_phone["road_edge"]["level"], "visual")
        self.assertNotIn("distance_m", old_phone["road_edge"])
        upload(a, left[:100], now)
        self.assertEqual(read()["stereo_status"], "size_mismatch")
        b = pair("B")
        upload(a, left, now)
        self.assertEqual(read()["stereo_status"], "waiting_for_pair")

        # A calibration solved in grid units needs a measured scale even with meters enabled.
        worker.stereo.square_units = True
        for tick, (meters, width, expected) in enumerate([(True,0,None),(True,125,.05),(False,125,None)]):
            prefs = dict(spatial=True,temporal=True,meters=meters,fiveMm=width)
            request("GET", "/api/preview/A", desk, headers={"X-Depth-Options":json.dumps(prefs)})
            stamp = int(time.time()*1000)+tick
            upload(b, right, stamp)
            upload(a, left, stamp)
            snap = read()
            self.assertEqual(snap["stereo_status"],"ready")
            self.assertEqual(snap["depth_options"],prefs)
            if width == 0:
                self.assertEqual(snap["road_edge"]["level"], "visual")
                self.assertNotIn("distance_m", snap["road_edge"])
            else:
                # Road warnings use meters independently of the display toggle.
                self.assertAlmostEqual(snap["road_edge"]["distance_m"], 2*width/5000, delta=.002)
            if expected is None:
                self.assertNotIn("depth_m",snap["objects"][0])
                self.assertNotIn("center_m",snap)
            else:
                self.assertAlmostEqual(snap["objects"][0]["depth_m"],expected,delta=.002)
                self.assertAlmostEqual(snap["center_m"],expected,delta=.002)

        get = http.get

        def time_out_partner(url, **kwargs):
            if url.endswith("/stereo-partner"):
                raise requests.Timeout("Simulated unavailable stereo partner")
            return get(url, **kwargs)

        upload(a, left, now)
        with patch.object(http, "get", side_effect=time_out_partner):
            unavailable = read()
        self.assertEqual(unavailable["stereo_status"], "unavailable")
        self.assertEqual(unavailable["objects"][0]["label"], "chair")
        self.assertNotIn("depth_preview", unavailable)


if __name__ == "__main__":
    unittest.main()
