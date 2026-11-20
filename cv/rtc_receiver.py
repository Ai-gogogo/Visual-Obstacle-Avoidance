"""Receive LAN camera tracks and publish bounded compatibility snapshots."""
import asyncio
import base64
import json
import os
import sys
import time
from contextlib import suppress

from aiohttp import web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCRtpSender, RTCSessionDescription, VideoStreamTrack
from aiortc.mediastreams import MediaStreamError
from av import CodecContext
from rtc_timing import CaptureTimeline, video_ssrc

SNAPSHOT_PERIOD = 0.1
FRAME_TIMEOUT = 4
FIRST_FRAME_TIMEOUT = 20
MAX_SOURCES = 8


class Camera:
    def __init__(self, quality):
        self.peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.quality = quality
        self.viewer = None
        self.viewer_id = None
        self.changed = asyncio.Event()
        self.frame = None
        self.sequence = 0
        self.closed = False
        self.reader = None
        self.sampler = None
        self.decoded_at = 0
        self.timeline = CaptureTimeline()

    async def next_frame(self, sequence):
        while self.sequence == sequence and not self.closed:
            self.changed.clear()
            await self.changed.wait()
        if self.closed:
            raise MediaStreamError
        return self.sequence, self.frame


class Preview(VideoStreamTrack):
    def __init__(self, camera):
        super().__init__()
        self.camera = camera
        self.sequence = 0

    async def recv(self):
        self.sequence, frame = await self.camera.next_frame(self.sequence)
        return frame


class SnapshotEncoder:
    def __init__(self, max_edge):
        self.codec = None
        self.max_edge = max_edge

    def encode(self, frame):
        scale = min(1, self.max_edge / max(frame.width, frame.height))
        width = max(2, round(frame.width * scale / 2) * 2)
        height = max(2, round(frame.height * scale / 2) * 2)
        if self.codec is None or (width, height) != (self.codec.width, self.codec.height):
            self.codec = CodecContext.create("mjpeg", "w")
            self.codec.width, self.codec.height = width, height
            self.codec.pix_fmt = "yuvj420p"
            self.codec.qmin = 3
            self.codec.qmax = 8
        image = frame.reformat(width=width, height=height, format="yuvj420p")
        return base64.b64encode(b"".join(bytes(packet) for packet in self.codec.encode(image))).decode("ascii")


async def main():
    secret = os.environ["VISIONASSIST_RTC_BRIDGE_KEY"]
    cameras = {}
    output_lock = asyncio.Lock()

    async def emit(**message):
        async with output_lock:
            await asyncio.to_thread(print, json.dumps(message, separators=(",", ":")), flush=True)

    async def close_camera(camera_id, camera):
        if camera.closed:
            return
        camera.closed = True
        if cameras.get(camera_id) is camera:
            cameras.pop(camera_id)
        camera.changed.set()
        background = [
            task for task in (camera.reader, camera.sampler)
            if task is not None and task is not asyncio.current_task()
        ]
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        if camera.viewer:
            await camera.viewer.close()
        await camera.peer.close()
        await emit(kind="closed", id=camera_id)

    async def collect(camera_id, camera, track):
        try:
            while not camera.closed:
                timeout = FRAME_TIMEOUT if camera.sequence else FIRST_FRAME_TIMEOUT
                frame = await asyncio.wait_for(track.recv(), timeout)
                if not camera.sequence:
                    print(f"WebRTC first frame: {frame.width} x {frame.height}, requested {camera.quality}",
                          file=sys.stderr, flush=True)
                camera.sequence += 1
                camera.frame = frame
                camera.decoded_at = time.time_ns() // 1_000_000
                camera.changed.set()
        except TimeoutError:
            print(f"WebRTC frame timeout: decoded={camera.sequence}, ICE={camera.peer.iceConnectionState}",
                  file=sys.stderr, flush=True)
        except MediaStreamError:
            pass
        finally:
            await close_camera(camera_id, camera)

    async def sample(camera_id, camera):
        sequence = 0
        expected = {"portrait-low": (480, 640), "portrait-full": (1080, 1920)}.get(camera.quality)
        encoder = SnapshotEncoder(max(expected) if expected else (960 if camera.quality == "hd" else 640))
        previous_frames = 0
        last_size = None
        previous_time = time.monotonic()
        fps = 0
        try:
            while not camera.closed:
                sequence, frame = await camera.next_frame(sequence)
                if expected and (frame.width, frame.height) != expected:
                    if last_size != (frame.width, frame.height):
                        last_size = (frame.width, frame.height)
                        await emit(kind="size", id=camera_id, width=frame.width, height=frame.height)
                    # A transient adaptation must never enter calibration as the requested mode.
                    await asyncio.sleep(SNAPSHOT_PERIOD)
                    continue
                last_size = None
                decoded_at = camera.decoded_at
                timing = camera.timeline.estimate(frame, time.monotonic_ns() // 1_000_000)
                jpeg = await asyncio.to_thread(encoder.encode, frame)
                now = time.monotonic()
                if now - previous_time >= 1:
                    fps = round((camera.sequence - previous_frames) / (now - previous_time), 1)
                    previous_frames = camera.sequence
                    previous_time = now
                if not camera.closed:
                    await emit(kind="frame", id=camera_id, jpeg=jpeg, decoded_at=decoded_at,
                               decoded_frames=camera.sequence, fps=fps, capture=timing,
                               width=frame.width, height=frame.height)
                await asyncio.sleep(SNAPSHOT_PERIOD)
        except MediaStreamError:
            pass
        except Exception:
            await close_camera(camera_id, camera)

    async def control(request):
        if request.headers.get("X-Bridge-Key") != secret:
            raise web.HTTPForbidden()
        camera_id = request.match_info["id"]
        camera = cameras.get(camera_id)
        viewer = request.match_info["role"] == "view"
        viewer_id = request.query.get("viewer")
        if request.method == "DELETE":
            if viewer and camera and camera.viewer and camera.viewer_id == viewer_id:
                peer, camera.viewer = camera.viewer, None
                camera.viewer_id = None
                await peer.close()
            elif not viewer and camera:
                await close_camera(camera_id, camera)
            return web.Response(status=204)

        if viewer and (not camera or not camera.frame):
            raise web.HTTPNotFound()
        if not viewer and (camera or len(cameras) >= MAX_SOURCES):
            raise web.HTTPServiceUnavailable()
        offer = await request.json()
        # A single video media section keeps the bridge camera-only.
        media = [line for line in offer["sdp"].splitlines() if line.startswith("m=")]
        if len(media) != 1 or not media[0].startswith("m=video "):
            raise web.HTTPBadRequest()

        if viewer:
            peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            outbound = peer.addTransceiver("video", direction="sendonly")
            if camera.quality in ("hd", "portrait-full"):
                codecs = RTCRtpSender.getCapabilities("video").codecs
                outbound.setCodecPreferences(sorted(codecs, key=lambda codec: codec.mimeType != "video/H264"))
            old_viewer, camera.viewer = camera.viewer, peer
            camera.viewer_id = viewer_id
            if old_viewer:
                await old_viewer.close()
        else:
            camera = cameras[camera_id] = Camera(offer.get("quality", "standard"))
            peer = camera.peer

            @peer.on("track")
            def receive(track):
                camera.reader = asyncio.create_task(collect(camera_id, camera, track))
                camera.sampler = asyncio.create_task(sample(camera_id, camera))

        @peer.on("connectionstatechange")
        async def state_changed():
            if peer.connectionState == "failed":
                if viewer:
                    if camera.viewer is peer:
                        camera.viewer = None
                        camera.viewer_id = None
                    await peer.close()
                else:
                    await close_camera(camera_id, camera)

        try:
            async with asyncio.timeout(5):
                await peer.setRemoteDescription(RTCSessionDescription(sdp=offer["sdp"], type="offer"))
                if viewer:
                    outbound.sender.replaceTrack(Preview(camera))
                elif camera.reader is None:
                    raise ValueError("A sending video track is required")
                else:
                    receiver, = peer.getReceivers()
                    camera.timeline.attach(receiver, video_ssrc(offer["sdp"]))
                await peer.setLocalDescription(await peer.createAnswer())
            if camera.closed or (viewer and camera.viewer is not peer):
                raise ConnectionError
        except Exception:
            if viewer:
                if camera.viewer is peer:
                    camera.viewer = None
                    camera.viewer_id = None
                await peer.close()
            else:
                await close_camera(camera_id, camera)
            raise web.HTTPBadRequest() from None
        return web.json_response({"type": "answer", "sdp": peer.localDescription.sdp})

    app = web.Application(client_max_size=65536)
    app.router.add_post("/{role:camera|view}/{id}", control)
    app.router.add_delete("/{role:camera|view}/{id}", control)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    # Bind signaling to loopback. WebRTC ICE separately binds UDP media sockets.
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    await emit(kind="ready", port=runner.addresses[0][1])
    try:
        # Node owns the subprocess. Closing its stdin also ends the worker.
        await asyncio.to_thread(sys.stdin.buffer.read, 1)
    finally:
        with suppress(BrokenPipeError):
            await asyncio.gather(*(close_camera(i, c) for i, c in list(cameras.items())))
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
