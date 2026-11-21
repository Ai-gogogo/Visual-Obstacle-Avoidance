"""Replay phone JPEGs against the real pairing, CV and Agent routes."""
import base64
import io
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import requests
from PIL import Image
from ultralytics import YOLO
from ultralytics.utils import ASSETS

from detect_image import DEFAULT_WEIGHTS
from live_camera import CameraAWorker, CameraWorker, resolve_device
from obstacles import PlaneObstacles
from path_intrusion import Corridor
from road_edge import DEFAULT_ROAD_CONFIG
from scene_alerts import SceneAlertSampler, observe_door
from stereo_depth import DEFAULT_CONFIG, StereoDepth


class DeviceSelectionTests(unittest.TestCase):
    def test_auto_prefers_cuda_then_mps_then_cpu(self):
        for cuda, mps, expected in [(True, True, "cuda:0"), (False, True, "mps"),
                                    (False, False, "cpu")]:
            with patch("torch.cuda.is_available", return_value=cuda), patch("torch.backends.mps.is_available", return_value=mps):
                self.assertEqual(resolve_device("auto"), expected)
                self.assertEqual(resolve_device("cpu"), "cpu")


def phone_jpeg(image):
    image = image.copy()
    image.thumbnail((640, 640))
    data = io.BytesIO()
    image.save(data, "JPEG", quality=70)
    return data.getvalue()


class LiveCameraTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = YOLO(str(DEFAULT_WEIGHTS), task="detect")
        with Image.open(ASSETS / "bus.jpg") as image:
            cls.bus = phone_jpeg(image)
        cls.blank = phone_jpeg(Image.new("RGB", (640, 480), "white"))

    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        script = """const {createServer}=require('./web/server.cjs');
        const s=createServer({agent:{filename:':memory:'}});
        s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"""
        server = subprocess.Popen(["node", "-e", script], cwd=root,
                                  stdout=subprocess.PIPE, text=True)
        self.addCleanup(server.stdout.close)
        self.addCleanup(server.wait, 5)
        self.addCleanup(server.terminate)
        self.base = "http://127.0.0.1:" + str(int(server.stdout.readline()))
        self.http = requests.Session()
        self.addCleanup(self.http.close)
        self.cv = requests.Session()
        self.addCleanup(self.cv.close)
        self.worker = CameraAWorker(self.base, self.model, self.cv)
        self.desk = self.request("POST", "/api/session").json()["token"]
        self.assertEqual(self.scene()["source"], "unavailable")

    def request(self, method, path, token=None, **kwargs):
        headers = kwargs.pop("headers", {})
        if token:
            headers["Authorization"] = "Bearer " + token
        response = self.http.request(method, self.base + path, headers=headers, timeout=5, **kwargs)
        response.raise_for_status()
        return response

    def pair(self, side):
        code = self.request("POST", "/api/pair/" + side, self.desk).json()["code"]
        return self.request("POST", "/api/join", json={"code": code}).json()["token"]

    def upload(self, phone, jpeg):
        self.request("PUT", "/api/frame", phone, data=jpeg, headers={"Content-Type": "image/jpeg"})

    def scene(self, side="A"):
        return self.request("POST", "/api/agent/chat", self.desk,
                            json={"camera_id": side, "text": "What is in front of me?"}).json()

    def test_masked_measurements_on_wire_use_raw_meters_and_preserve_object_indices(self):
        from test_stereo_depth import configuration

        stereo = StereoDepth(configuration())
        stereo.square_units = True
        raw = np.full((192, 320), 120., dtype=np.float32)  # 3 m, at 25 mm per grid unit.
        masks = []
        for x, units in [(10, 100), (50, 80), (225, 60)]:
            mask = np.zeros_like(raw, dtype=bool)
            mask[40:120, x:x+12] = True
            raw[mask] = units
            raw[40:57, x:x+12] = units - 4
            masks.append(mask)
        def infer(_):
            return ([dict(label="person", confidence=c, position="center", bbox=[0., .1, 1., .9])
                     for c in (.3, .9, .8)], masks)
        worker = CameraWorker(self.base, None, self.cv, stereo=stereo, infer=infer, plane=PlaneObstacles())
        plane = SimpleNamespace(validated=True, reason="ok", normal=np.array([0., 0., -1.]),
                                d=3., holdout_p90_m=.01, pitch_deg=90., roll_deg=0., inlier_ratio=1.)
        jpeg = phone_jpeg(Image.new("RGB", stereo.size))
        phones = [self.pair(side) for side in "BA"]
        stamp = str(int(time.time()*1000))
        for phone in phones:
            self.request("PUT", "/api/frame", phone, data=jpeg, headers={
                "Content-Type": "image/jpeg", "X-Sample-Ms": stamp, "X-Clock-Error-Ms": "2"})
        self.request("GET", "/api/preview/A", self.desk, headers={"X-Depth-Options": json.dumps(
            dict(spatial=True, temporal=True, fiveMm=125, meters=True))})
        replies = []
        self.cv.hooks["response"].append(lambda response, **_: replies.append(response))
        with (patch.object(stereo, "compute", return_value=raw),
              patch("live_camera.spatial_depth", return_value=np.full_like(raw, 7)) as spatial,
              patch("live_camera.StaticMedian.apply", return_value=np.full_like(raw, 9)) as temporal,
              patch("live_camera.fit_support_plane", return_value=plane)):
            worker.poll()
        spatial.assert_called_once()
        temporal.assert_called_once()
        response, = [r for r in replies if r.request.method == "POST"]
        self.assertTrue(response.ok, response.text)
        self.assertIn("/api/cv/detections?", response.url)
        self.assertNotIn(b"mask", response.request.body.lower())
        self.assertLess(len(response.request.body), 4000)
        objects = json.loads(response.request.body)["objects"]
        self.assertEqual([(o["depth_m"], o["nearest_depth_m"], o["height_above_plane_m"]) for o in objects],
                         [(2., 1.9, 1.), (1.5, 1.4, 1.5)])

    def test_agent_uses_fetched_frame_when_camera_changes_twice(self):
        a = self.pair("A")
        self.upload(self.pair("B"), self.bus)
        self.upload(a, self.blank)
        # Discovery sees a blank. The frame GET sees a bus. Before inference
        # starts the phone has already uploaded another blank. All three IDs differ.
        original_get = self.cv.get
        frame_ids = {}
        metadata = {}

        def switch_after_read(url, **kwargs):
            response = original_get(url, **kwargs)
            if url.endswith("/sources"):
                [camera_a] = [s for s in response.json()["sources"] if s["camera_id"] == "A"]
                frame_ids["discovered"] = camera_a["frame_id"]
                self.upload(a, self.bus)
            elif url.endswith("/frame"):
                frame_ids["fetched"] = response.headers["ETag"].strip('"')
                frame_stamp = int(response.headers["X-CV-Frame-Ms"])
                metadata.update(schema_version=1, camera_id="A", timestamp_ms=frame_stamp)
                self.upload(a, self.blank)
                preview = self.request("GET", "/api/frame/A", self.desk)
                frame_ids["latest"] = preview.headers["ETag"].strip('"')
            return response

        with (patch.object(self.cv, "get", side_effect=switch_after_read),
              patch.object(self.cv, "post", wraps=self.cv.post) as publish):
            self.worker.poll()
        self.assertEqual(len(set(frame_ids.values())), 3)
        payload = publish.call_args.kwargs["json"]
        self.assertEqual(payload["frame_id"], frame_ids["fetched"])
        self.assertEqual({key: payload[key] for key in metadata}, metadata)
        reply = self.scene()
        self.assertEqual(reply["source"], "yolo")
        self.assertIn("bus (center)", reply["reply_text"])
        self.assertEqual(self.scene("B")["source"], "unavailable")

        with patch.object(self.model, "predict", wraps=self.model.predict) as predict:
            self.worker.poll()
            empty = self.scene()
            self.assertEqual(empty["source"], "yolo")
            self.assertIn("no confident detections", empty["reply_text"])
            self.worker.poll()  # Discovery still reports the same frame.
            self.assertEqual(predict.call_count, 1)

    def test_relative_depth_in_each_camera_preview_and_agent(self):
        with Image.open(ASSETS / "bus.jpg") as photo:
            person = photo.crop((44, 390, 244, 907))
        phones = {side: self.pair(side) for side in "AB"}
        b_worker = CameraWorker(self.base, self.model, self.cv, "B")
        def replay(side, worker, placements):
            image = Image.new("RGB", (640, 540), "#dedede")
            for x, z in placements:
                # Level camera: projected body height and foot-to-horizon offset vary as 1/z.
                height = round(510 / z)
                feet = round(190 + 450 / z)
                sprite = person.resize((round(height * person.width / person.height), height))
                image.paste(sprite, (x, feet - height))
            self.upload(phones[side], phone_jpeg(image))
            worker.poll()
            snapshot = self.request("GET", "/api/preview/" + side, self.desk).json()
            return {o["position"]: o.get("relative_depth") for o in snapshot["objects"] if o["label"] == "person"}

        def ask(side, question="Which object is closer?"):
            return self.request("POST", "/api/agent/chat", self.desk,
                                json={"camera_id": side, "text": question}).json()["reply_text"]

        self.assertEqual(replay("A", self.worker, [(40, 2), (505, 4)]), {"left":"near", "right":"far"})
        self.assertEqual(replay("B", b_worker, [(40, 4), (505, 2)]), {"left":"far", "right":"near"})
        self.assertIn("person (left)", ask("A"))
        self.assertNotIn("person (right)", ask("A"))
        self.assertIn("person (right)", ask("B"))
        self.assertIn("人在画面右侧", ask("A", "哪个物体更远？"))
        self.assertEqual(replay("A", self.worker, [(40, 2)]), {"left":"unknown"})
        self.assertIn("cannot tell", ask("A"))

    def test_lost_ack_retries_identical_tracks_without_repeating_inference(self):
        self.upload(self.pair("A"), self.bus)
        post = self.cv.post
        sent = []

        def lose_first_ack(url, **kwargs):
            response = post(url, **kwargs)
            self.assertEqual(response.status_code, 204)
            sent.append(kwargs["json"])
            if len(sent) == 1:
                raise requests.ConnectionError("Simulated lost acknowledgement")
            return response

        with (patch.object(self.cv, "post", side_effect=lose_first_ack),
              patch.object(self.model, "predict", wraps=self.model.predict) as predict):
            with self.assertRaises(requests.ConnectionError):
                self.worker.poll()
            self.worker.poll()
            self.assertEqual(predict.call_count, 1)
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0], sent[1])
        self.assertTrue(all(o["track_id"] for o in sent[0]["objects"]))
        self.assertIn("bus (center)", self.scene()["reply_text"])

    def test_dashboard_returns_pixels_and_boxes_from_one_processed_frame(self):
        phone = self.pair("A")
        path = "/api/preview/A"
        self.upload(phone, self.bus)
        raw = self.request("GET", path, self.desk)
        self.assertIsNone(raw.json()["objects"])
        self.worker.poll()
        annotated = self.request("GET", path, self.desk, headers={"If-None-Match": raw.headers["ETag"]})
        scene = annotated.json()
        self.assertEqual(scene["frame_id"], raw.json()["frame_id"])
        self.assertTrue(any(o["label"] == "bus" for o in scene["objects"]))
        self.upload(phone, self.blank)  # Camera outpaces inference.
        pending = self.request("GET", path, self.desk).json()
        self.assertEqual(pending, scene)
        self.assertEqual(base64.b64decode(pending["jpeg"]), self.bus)
        self.assertEqual(self.request("GET", path, self.desk, headers={
            "If-None-Match": annotated.headers["ETag"]}).status_code, 304)
        self.worker.poll()
        empty = self.request("GET", path, self.desk).json()
        self.assertNotEqual(empty["frame_id"], scene["frame_id"])
        self.assertEqual(base64.b64decode(empty["jpeg"]), self.blank)
        self.assertEqual(empty["objects"], [])
        self.assertIn("no confident detections", self.scene()["reply_text"])
        other = self.request("POST", "/api/session").json()["token"]
        self.assertEqual(self.request("GET", path, other).status_code, 204)
        self.assertEqual(self.http.get(self.base + path, headers={
            "Authorization": "Bearer " + phone}, timeout=5).status_code, 401)
        self.request("DELETE", "/api/frame", phone)
        self.assertEqual(self.request("GET", path, self.desk).status_code, 204)

    def test_expired_result_is_discarded_and_camera_can_reconnect(self):
        a = self.pair("A")
        self.upload(a, self.bus)
        post = self.cv.post
        statuses = []

        def publish_after_expiry(url, **kwargs):
            time.sleep(5.1)  # Real server freshness window is five seconds.
            response = post(url, **kwargs)
            statuses.append(response.status_code)
            return response

        with patch.object(self.cv, "post", side_effect=publish_after_expiry):
            self.worker.poll()
        self.assertEqual(statuses, [409])
        self.assertEqual(self.scene()["source"], "unavailable")
        self.request("DELETE", "/api/frame", a)
        self.worker.poll()  # No A present.
        self.upload(self.pair("A"), self.bus)
        self.worker.poll()
        self.assertIn("bus (center)", self.scene()["reply_text"])

    def test_dual_cli_keeps_frames_and_answers_separate_after_b_disconnects(self):
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("live_camera.py")),
                                    "--server", self.base, "--dual-yolo"])
        self.addCleanup(process.wait, 5)
        self.addCleanup(process.terminate)
        phones = {side: self.pair(side) for side in "AB"}
        images = {"A": self.bus, "B": self.blank}

        def wait_for_results():
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                self.assertIsNone(process.poll())
                for side, jpeg in images.items():
                    self.upload(phones[side], jpeg)
                time.sleep(0.22)
                results = {}
                for side, jpeg in images.items():
                    value = self.request("GET", "/api/preview/" + side, self.desk).json()
                    if value["objects"] is not None and base64.b64decode(value["jpeg"]) == jpeg:
                        results[side] = value
                if len(results) == len(images):
                    return results
            self.fail("A camera did not publish fresh matching detections")

        both = wait_for_results()
        self.assertNotEqual(both["A"]["frame_id"], both["B"]["frame_id"])
        source = self.request("GET", "/api/cv/sources").json()["sources"][0]["source_id"]
        wrong = self.cv.post(self.base + "/api/cv/detections", params={"source_id": source, "camera_id": "B"},
                             json={"frame_id": both["A"]["frame_id"], "objects": both["A"]["objects"]}, timeout=3)
        self.assertEqual(wrong.status_code, 409)
        self.assertTrue(any(o["label"] == "bus" for o in both["A"]["objects"]))
        self.assertEqual(both["B"]["objects"], [])
        self.assertIn("bus (center)", self.scene("A")["reply_text"])
        self.assertIn("no confident detections", self.scene("B")["reply_text"])
        self.request("DELETE", "/api/frame", phones["B"])
        images = {"A": self.blank}
        after = wait_for_results()
        self.assertNotEqual(after["A"]["frame_id"], both["A"]["frame_id"])
        self.assertEqual(after["A"]["objects"], [])
        self.assertIn("no confident detections", self.scene("A")["reply_text"])
        self.assertEqual(self.scene("B")["source"], "unavailable")
        self.assertEqual(self.request("GET", "/api/preview/B", self.desk).status_code, 204)

    def test_track_ids_in_two_person_replay_and_immediate_repair(self):
        phones = {side: self.pair(side) for side in "AB"}
        b_worker = CameraWorker(self.base, self.model, self.cv, "B")
        with Image.open(ASSETS / "bus.jpg") as photo:
            upper = photo.crop((44, 390, 244, 907))
            lower = photo.crop((220, 402, 346, 862))
        for crop in [upper, lower]:
            crop.thumbnail((110, 240))

        def frame_at(x):
            image = Image.new("RGB", (640, 540), "#dedede")
            image.paste(upper, (x, 8))
            image.paste(lower, (540 - x, 282))
            return phone_jpeg(image)

        def people(side):
            snapshot = self.request("GET", "/api/preview/" + side, self.desk).json()
            people = sorted((o for o in snapshot["objects"] if o["label"] == "person"),
                            key=lambda o: o["bbox"][1])
            self.assertEqual(len(people), 2)
            self.assertTrue(all(o["track_id"] for o in people))
            self.assertNotEqual(people[0]["track_id"], people[1]["track_id"])
            return [o["track_id"] for o in people], people[0]["position"]

        positions = set()
        for i, x in enumerate(range(32, 514, 24)):
            self.upload(phones["A"], frame_at(x))
            self.worker.poll()
            ids, position = people("A")
            positions.add(position)
            if i == 0:
                a_ids = ids
            self.assertEqual(ids, a_ids)
        self.assertEqual(positions, {"left", "center", "right"})
        self.upload(phones["B"], frame_at(32))
        b_worker.poll()
        b_ids, _ = people("B")
        self.assertTrue(set(a_ids).isdisjoint(b_ids))

        # Replace A directly between polls; source_id is unchanged, with no offline poll.
        phones["A"] = self.pair("A")
        self.upload(phones["A"], frame_at(x))
        self.worker.poll()
        self.assertTrue(set(a_ids).isdisjoint(people("A")[0]))
        self.upload(phones["B"], frame_at(40))
        b_worker.poll()
        self.assertEqual(people("B")[0], b_ids)

    def test_door_segmentation_publishes_in_the_background(self):
        phone = self.pair("A")
        segmenting = Event()
        release = Event()
        mask = np.zeros((128, 128), dtype=bool)
        mask[18:108, 43:85] = True

        def segment(_image, depth):
            segmenting.set()
            release.wait(2)
            return {"door": observe_door(mask, depth)}

        self.worker.infer = lambda _: []
        with SceneAlertSampler(segment, self.worker.api) as sampler:
            self.worker.scene_alert_sampler = sampler
            try:
                self.upload(phone, self.blank)
                self.worker.poll()
                self.assertTrue(segmenting.wait(2))
                self.upload(phone, self.bus)
                self.worker.poll()
                response = self.request("GET", "/api/agent/alerts", self.desk).json()
                self.assertEqual(response["cameras"]["A"], "detecting")
                self.assertEqual(response["alerts"], [])
            finally:
                release.set()
            response = self.request("GET", "/api/agent/alerts?wait=1&after=0", self.desk).json()
            self.assertEqual([alert["text_zh"] for alert in response["alerts"]],
                             ["请小心，前方可能有门。"])

    def test_predict_crossing_before_entry_and_drop_alert_after_b_repair(self):
        phones = {side: self.pair(side) for side in "AB"}
        config = json.loads(DEFAULT_CONFIG.read_text())
        camera = dict(fx=420, fy=420, cx=320, cy=180, distortion=[0]*5)
        config.update(image_size_px=[640, 360], baseline_m=.12, camera_A=camera, camera_B=camera,
                      rotation_A_to_B=np.eye(3).tolist(), translation_direction_A_to_B=[-1, 0, 0])
        self.worker.original_stereo = StereoDepth(config)
        self.worker.corridor = Corridor.load(DEFAULT_ROAD_CONFIG)
        with Image.open(ASSETS / "bus.jpg") as photo:
            person = photo.crop((44, 390, 244, 907)).resize((76, 197))
        rng = np.random.default_rng(449)
        wall = Image.fromarray(rng.integers(100, 205, (360, 640), dtype=np.uint8)).convert("RGB")
        predictions = []
        for x in range(467, 385, -13):
            left = wall.copy()
            left.paste(person, (x, 92))
            right = Image.new("RGB", left.size)
            right.paste(left, (-12, 0))  # Uniform known disparity (4.2 m).
            stamp = int(time.time()*1000)
            for side, frame in [('B',right), ('A',left)]:
                self.request("PUT", "/api/frame", phones[side], data=phone_jpeg(frame),
                             headers={"Content-Type":"image/jpeg","X-Sample-Ms":str(stamp),"X-Clock-Error-Ms":"2"})
            self.request("GET", "/api/preview/A", self.desk,
                         headers={"X-Depth-Options": json.dumps({"meters": False})})
            self.worker.poll()
            snapshot = self.request("GET", "/api/preview/A", self.desk).json()
            predictions.extend(o for o in snapshot["objects"] if o.get("intrusion"))
            alerts = self.request("GET", "/api/agent/alerts", self.desk).json()["alerts"]
            warnings = [a for a in alerts if a.get("kind") == "path_intrusion"]
            if warnings:
                break
            time.sleep(.18)
        self.assertTrue(predictions)
        self.assertNotIn("depth_m", predictions[-1])  # Hidden readings still support crossing alerts.
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["track_id"], predictions[-1]["track_id"])
        self.assertEqual(warnings[0]["from_side"], "right")
        self.assertIn("右侧行人", warnings[0]["text_zh"])
        self.assertLessEqual(predictions[-1]["intrusion"]["eta_s"], 2)
        self.assertGreater(predictions[-1]["bbox"][0]*640, 320+.45*420/4.2)
        self.worker.poll()  # Identical frame is not published twice.
        self.assertEqual(self.request("GET", "/api/agent/alerts?after="+str(warnings[0]["id"]), self.desk).json()["alerts"], [])
        self.pair("B")
        events = self.request("GET", "/api/agent/alerts", self.desk).json()["alerts"]
        self.assertFalse(any(e.get("kind") == "path_intrusion" for e in events))
        preview = self.request("GET", "/api/preview/A", self.desk).json()
        self.assertTrue(all("intrusion" not in o for o in preview["objects"]))

    def test_running_cli_follows_phone_uploads(self):
        script = Path(__file__).with_name("live_camera.py")
        process = subprocess.Popen([sys.executable, str(script), "--server", self.base])
        self.addCleanup(process.wait, 5)
        self.addCleanup(process.terminate)
        self.upload(self.pair("B"), self.bus)
        phone = self.pair("A")
        for image, expected in [(self.bus, "bus (center)"), (self.blank, "no confident detections")]:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                self.assertIsNone(process.poll(), "Live worker exited during the stream")
                self.upload(phone, image)
                time.sleep(0.22)  # Approximate the phone uploader's cadence.
                reply = self.scene()
                if reply["source"] == "yolo" and expected in reply["reply_text"]:
                    break
            else:
                self.fail(f"Agent did not report {expected!r}; last reply: {reply}")
        self.assertEqual(self.scene("B")["source"], "unavailable")
