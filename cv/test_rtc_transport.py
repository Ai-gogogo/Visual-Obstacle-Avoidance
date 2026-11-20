"""Opt-in integration exercise, requiring rtc-requirements.txt and Node 24."""
import asyncio
import base64
import os
from pathlib import Path
import sys
import time
import unittest
from uuid import uuid4

try:
    from aiohttp import ClientSession
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
    from av import CodecContext, Packet, VideoFrame
    from rtc_receiver import SnapshotEncoder
except ModuleNotFoundError as error:
    raise unittest.SkipTest("Run with the environment from rtc-requirements.txt.") from error


class ClockedVideo(VideoStreamTrack):
    size = (480, 640)

    async def recv(self):
        frame = (await super().recv()).reformat(width=self.size[0], height=self.size[1])
        frame.pts = time.monotonic_ns() * 90_000 // 1_000_000_000
        return frame


class TransportTest(unittest.IsolatedAsyncioTestCase):
    def test_hd_snapshot_retains_more_pixels(self):
        frame = VideoFrame(1280, 720, "yuv420p")
        for edge, expected in ((640, (640, 360)), (960, (960, 540))):
            payload = base64.b64decode(SnapshotEncoder(edge).encode(frame))
            decoded, = CodecContext.create("mjpeg", "r").decode(Packet(payload))
            self.assertEqual((decoded.width, decoded.height), expected)

    async def test_two_pairs_preview_and_jpeg_fallback(self):
        root = Path(__file__).resolve().parents[1]
        node = await asyncio.create_subprocess_exec(
            "node", "-e",
            "const server=require('./web/server.cjs').createServer("
            "{rtcPython:process.env.TEST_RTC_PYTHON,agent:{filename:':memory:'}});"
            "server.listen(0,'127.0.0.1',()=>console.log(server.address().port));"
            "process.stdin.on('end',()=>server.close());process.stdin.resume();",
            env={**os.environ, "TEST_RTC_PYTHON": sys.executable}, cwd=root,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        )

        async def finish():
            node.stdin.close()
            try:
                self.assertEqual(await asyncio.wait_for(node.wait(), 7), 0)
            except TimeoutError:
                node.kill()
                await node.wait()
                raise

        self.addAsyncCleanup(finish)
        port = int(await asyncio.wait_for(node.stdout.readline(), 10))
        async with ClientSession(f"http://127.0.0.1:{port}") as http:
            async def call(method, path, status, token=None, **kwargs):
                headers = kwargs.pop("headers", {})
                if token:
                    headers["Authorization"] = f"Bearer {token}"
                async with http.request(method, path, headers=headers, **kwargs) as response:
                    body = await response.read()
                    self.assertEqual(response.status, status, (path, body[:250]))
                    return await response.json() if body else None

            dashboard = (await call("POST", "/api/session", 201))["token"]
            other = (await call("POST", "/api/session", 201))["token"]
            await call("POST", "/api/webrtc/offer", 401, dashboard, json={})

            async def negotiate(peer, path, token):
                await peer.setLocalDescription(await peer.createOffer())
                answer = await call("POST", path, 200, token,
                                    json={"sdp": peer.localDescription.sdp, "type": "offer"})
                await peer.setRemoteDescription(RTCSessionDescription(**answer))

            async def sync_clock(token):
                samples = []
                for _ in range(4):
                    sent = time.time_ns() // 1_000_000
                    clock = await call("GET", "/api/webrtc/clock", 200, token)
                    received = time.time_ns() // 1_000_000
                    samples.append((received - sent, clock, sent, received))
                _, clock, sent, received = min(samples, key=lambda sample: sample[0])
                await call("POST", "/api/webrtc/clock", 204, token,
                           json={**clock, "sent_ms": sent, "received_ms": received})

            async def pair(side):
                code = (await call("POST", f"/api/pair/{side}", 201, dashboard))["code"]
                phone = await call("POST", "/api/join", 200, json={"code": code})
                async with asyncio.timeout(10):
                    while not (await call("GET", "/api/webrtc/status", 200, phone["token"]))["available"]:
                        await asyncio.sleep(.2)
                peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
                self.addAsyncCleanup(peer.close)
                track = ClockedVideo()
                if side == "A":
                    track.size = (640, 480)
                peer.addTrack(track)
                await negotiate(peer, "/api/webrtc/offer?quality=portrait-low", phone["token"])
                if side == "A":
                    async with asyncio.timeout(5):
                        while True:
                            state = await call("GET", "/api/webrtc/status", 200, phone["token"])
                            if state.get("size_mismatch"):
                                break
                            await asyncio.sleep(.1)
                    self.assertFalse(state["receiving"])
                    self.assertEqual((state["width"], state["height"]), track.size)
                    track.size = (480, 640)
                return phone["token"]

            a, b = await asyncio.gather(pair("A"), pair("B"))
            async with asyncio.timeout(20):
                refresh = 0
                while True:
                    if time.monotonic() >= refresh:
                        await sync_clock(a)
                        await sync_clock(b)
                        refresh = time.monotonic() + 5
                    status = [await call("GET", "/api/webrtc/status", 200, token) for token in (a, b)]
                    if all(item.get("decoded_fps", 0) >= 15 and item["capture_timing_available"]
                           for item in status):
                        break
                    await asyncio.sleep(.2)
            print("Dual synthetic source decode FPS:", [item["decoded_fps"] for item in status])

            first = await call("GET", "/api/preview/A", 200, dashboard)
            decoded, = CodecContext.create("mjpeg", "r").decode(Packet(base64.b64decode(first["jpeg"])))
            self.assertEqual((decoded.width, decoded.height), (480,640))
            second = await call("GET", "/api/preview/B", 200, dashboard)
            self.assertNotEqual(first["frame_id"], second["frame_id"])
            self.assertTrue(first["webrtc"])
            await call("GET", "/api/preview/A", 204, other)

            await call("GET", "/api/agent/alerts", 200, dashboard)
            sources = (await call("GET", "/api/cv/sources", 200))["sources"]
            source = next(item for item in sources if item["camera_id"] == "A")
            query = f"?camera_id=A&source_id={source['source_id']}"
            async with asyncio.timeout(6):
                while True:
                    async with http.get("/api/cv/frame" + query) as response:
                        self.assertEqual(response.status, 200)
                        timed = "X-CV-Sample-Ms" in response.headers
                        frame_id = response.headers["etag"].strip('"')
                        pinned = await response.read()
                    partner = "/api/cv/stereo-partner" + query + "&frame_id=" + frame_id
                    async with http.get(partner + "&max_skew_ms=65") as response:
                        if response.status == 200:
                            self.assertTrue(timed)
                            skew = int(response.headers["X-Partner-Skew-Ms"])
                            bound = int(response.headers["X-Partner-Skew-Bound-Ms"])
                            self.assertLessEqual(skew, bound)
                            self.assertLessEqual(bound, 65)
                            await response.read()
                            break
                        self.assertEqual(response.status, 204)
                    await asyncio.sleep(.05)
            async with http.get(partner + "&max_skew_ms=1") as response:
                self.assertEqual(response.status, 204)
            await call("POST", "/api/cv/detections" + query, 204, json={"frame_id": frame_id, "objects": []})
            analysis = await call("GET", "/api/preview/A", 200, dashboard)
            self.assertEqual(analysis["frame_id"], frame_id)
            self.assertEqual(base64.b64decode(analysis["jpeg"]), pinned)

            viewer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            self.addAsyncCleanup(viewer.close)
            viewer.addTransceiver("video", direction="recvonly")
            track = asyncio.get_running_loop().create_future()
            viewer.on("track", track.set_result)
            path = f"/api/webrtc/view/A?viewer={uuid4()}"
            await call("POST", path, 404, other, json={})
            await negotiate(viewer, path, dashboard)
            remote = await asyncio.wait_for(track, 5)
            frame = await asyncio.wait_for(remote.recv(), 5)
            self.assertEqual((frame.width, frame.height), (480, 640))
            await call("DELETE", path, 204, dashboard)

            jpeg = base64.b64decode(first["jpeg"])
            await call("PUT", "/api/frame", 409, a, data=jpeg, headers={"Content-Type": "image/jpeg"})
            await call("DELETE", "/api/webrtc/offer", 204, a)
            await call("GET", "/api/preview/A", 204, dashboard)
            await call("POST", "/api/cv/detections" + query, 409,
                       json={"frame_id": frame_id, "objects": []})
            await call("PUT", "/api/frame", 204, a, data=jpeg, headers={"Content-Type": "image/jpeg"})
            fallback = await call("GET", "/api/preview/A", 200, dashboard)
            self.assertNotIn("webrtc", fallback)
            self.assertTrue((await call("GET", "/api/preview/B", 200, dashboard))["webrtc"])


if __name__ == "__main__":
    unittest.main()
