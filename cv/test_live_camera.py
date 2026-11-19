"""Replay phone JPEGs against the real pairing, CV and Agent routes."""
import io
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import requests
from PIL import Image
from ultralytics import YOLO
from ultralytics.utils import ASSETS

from detect_image import DEFAULT_WEIGHTS
from live_camera import CameraAWorker


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

    def test_agent_uses_fetched_frame_when_camera_changes_twice(self):
        a = self.pair("A")
        self.upload(self.pair("B"), self.bus)
        self.upload(a, self.blank)
        # Discovery sees a blank. The frame GET sees a bus. Before inference
        # starts the phone has already uploaded another blank. All three IDs differ.
        original_get = self.cv.get
        frame_ids = {}

        def switch_after_read(url, **kwargs):
            response = original_get(url, **kwargs)
            if url.endswith("/sources"):
                [camera_a] = [s for s in response.json()["sources"] if s["camera_id"] == "A"]
                frame_ids["discovered"] = camera_a["frame_id"]
                self.upload(a, self.bus)
            elif url.endswith("/frame"):
                frame_ids["fetched"] = response.headers["ETag"].strip('"')
                self.upload(a, self.blank)
                preview = self.request("GET", "/api/frame/A", self.desk)
                frame_ids["latest"] = preview.headers["ETag"].strip('"')
            return response

        with (patch.object(self.cv, "get", side_effect=switch_after_read),
              patch.object(self.cv, "post", wraps=self.cv.post) as publish):
            self.worker.poll()
        self.assertEqual(len(set(frame_ids.values())), 3)
        self.assertEqual(publish.call_args.kwargs["json"]["frame_id"], frame_ids["fetched"])
        reply = self.scene()
        self.assertEqual(reply["source"], "yolo")
        self.assertIn("bus (center)", reply["reply_text"])
        self.assertEqual(self.scene("B")["source"], "unavailable")

        with patch.object(self.model, "predict", wraps=self.model.predict) as predict:
            self.worker.poll()
            empty = self.scene()
            self.assertEqual(empty["source"], "yolo")
            self.assertIn("No confident objects", empty["reply_text"])
            self.worker.poll()  # Unchanged frame, HTTP 304.
            self.assertEqual(predict.call_count, 1)

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

    def test_running_cli_follows_phone_uploads(self):
        script = Path(__file__).with_name("live_camera.py")
        process = subprocess.Popen([sys.executable, str(script), "--server", self.base])
        self.addCleanup(process.wait, 5)
        self.addCleanup(process.terminate)
        phone = self.pair("A")
        for image, expected in [(self.bus, "bus (center)"), (self.blank, "No confident objects")]:
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
