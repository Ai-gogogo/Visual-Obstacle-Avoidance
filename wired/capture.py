"""Feed a local VisionAssist dashboard from two explicitly selected USB iPhones."""

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import dataclass
import getpass
import http.client
import json
import math
import os
import plistlib
import re
import socket
import struct
import sys
import time
import zlib

USB_SOCKET = "/var/run/usbmuxd"
PHONE_PORT = 18875
MAX_PNG = 12 * 1024 * 1024
FRESH_MS = 1000
PAIR_MS = 65
TIMEOUT = 3
MUX_HEADER = struct.Struct("<IIII")


def monotonic_ms():
    return time.monotonic_ns() / 1_000_000


def read_exact(channel, size):
    data = bytearray()
    while len(data) < size:
        part = channel.recv(size - len(data))
        if not part:
            raise ConnectionError("usbmuxd disconnected")
        data.extend(part)
    return data


def mux_socket():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(TIMEOUT)
    try:
        sock.connect(USB_SOCKET)
    except BaseException:
        sock.close()
        raise
    return sock


def mux_request(sock, kind, **fields):
    body = plistlib.dumps(
        dict(
            MessageType=kind,
            ClientVersionString="VisionAssist/1",
            ProgName="VisionAssist",
            kLibUSBMuxVersion=3,
            **fields,
        )
    )
    sock.sendall(MUX_HEADER.pack(16 + len(body), 1, 8, 1) + body)
    size, version, format_id, tag = MUX_HEADER.unpack(read_exact(sock, 16))
    if not 16 < size <= 1024 * 1024 or (version, format_id, tag) != (1, 8, 1):
        raise ValueError("Unexpected usbmuxd reply header")
    return plistlib.loads(bytes(read_exact(sock, size - 16)))


def usb_devices(records):
    devices = {}
    for record in records:
        props = record["Properties"]
        if props.get("ConnectionType") != "USB":
            continue
        serial, handle = props["SerialNumber"], record["DeviceID"]
        if serial in devices or handle in devices.values():
            raise ValueError("Ambiguous USB device list. Reconnect the phones and list them again.")
        devices[serial] = handle
    return devices


def list_devices():
    with closing(mux_socket()) as sock:
        reply = mux_request(sock, "ListDevices")
    if "DeviceList" not in reply:
        raise OSError("usbmuxd did not return the device list")
    return usb_devices(reply["DeviceList"])


class PhoneConnection(http.client.HTTPConnection):
    def __init__(self, serial):
        super().__init__("127.0.0.1", PHONE_PORT, timeout=TIMEOUT)
        self.serial = serial

    def connect(self):
        handle = list_devices().get(self.serial)
        if handle is None:
            raise ConnectionError(f"USB device {self.serial} is missing. Reconnect its data cable.")
        self.sock = mux_socket()
        reply = mux_request(
            self.sock, "Connect", DeviceID=handle, PortNumber=socket.htons(PHONE_PORT)
        )
        if reply.get("Number") != 0 or reply.get("MessageType") != "Result":
            raise ConnectionError(
                f"Open the wired camera app on {self.serial} and keep it in the foreground."
            )


def request(connection, method, path, limit, body=None, headers=None):
    with closing(connection):
        connection.request(method, path, body, headers or {})
        with connection.getresponse() as reply:
            meta = {k.lower(): v for k, v in reply.getheaders()}
            size = int(meta["content-length"]) if "content-length" in meta else None
            if size is not None and (size < 0 or size > limit):
                raise ValueError(f"{path} reply exceeds the accepted size")
            data = reply.read(limit + 1)
            if len(data) > limit:
                raise ValueError(f"{path} reply exceeds the accepted size")
            if size is not None and len(data) != size and reply.status not in (304, 204):
                raise ConnectionError(f"{path} reply was interrupted")
            return reply.status, meta, data


@dataclass(frozen=True)
class Clock:
    offset: float
    midpoint: float
    half_rtt: float

    @classmethod
    def from_samples(cls, samples):
        sent, remote, received = min(samples, key=lambda sample: sample[2] - sample[0])
        half = (received - sent) / 2
        if half > 12:
            raise OSError(
                "USB clock round trips exceed 24 ms. Check cables and close other camera users."
            )
        midpoint = sent + half
        return cls(midpoint - remote, midpoint, half)

    def convert(self, phone_ms):
        stamp = phone_ms + self.offset
        # Allow 100 ppm relative drift since the clock probe and timestamp rounding.
        error = math.ceil(self.half_rtt + abs(stamp - self.midpoint) * 0.0001 + 1)
        return stamp, error


def sync_clock(serial):
    samples = []
    for _ in range(4):
        # Tunnel setup predates the probe. Only time the small clock exchange.
        with closing(PhoneConnection(serial)) as conn:
            conn.connect()
            sent = monotonic_ms()
            status, _, data = request(conn, "GET", "/clock", 1024)
            received = monotonic_ms()
        if status != 200:
            raise OSError(f"Camera /clock returned HTTP {status}. Check the installed wired app.")
        remote = float(json.loads(data)["clockMs"])
        if not math.isfinite(remote):
            raise ValueError("Invalid phone clock")
        samples.append((sent, remote, received))
    return Clock.from_samples(samples)


@dataclass(frozen=True)
class Frame:
    stamp: float
    error: int
    phone_ms: float
    tag: str
    body: bytes


def check_png(data, size=(1080, 1920)):
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 45:
        raise ValueError("Expected a full portrait PNG from the wired camera app")
    if data[8:16] != b"\x00\x00\x00\rIHDR" or struct.unpack_from(">II", data, 16) != size:
        raise ValueError("Camera PNG dimensions differ from the selected resolution.")
    offset = 8
    pixels = False
    view = memoryview(data)
    while offset + 12 <= len(data):
        count, kind = struct.unpack_from(">I4s", data, offset)
        end = offset + 8 + count
        if (
            end + 4 > len(data)
            or zlib.crc32(view[offset + 4 : end]) != struct.unpack_from(">I", data, end)[0]
        ):
            break
        if kind == b"IDAT" and count:
            pixels = True
        if kind == b"IEND":
            if pixels and count == 0 and end + 4 == len(data):
                return
            break
        offset = end + 4
    raise ValueError("Incomplete or damaged PNG from the phone")


def decode_frame(headers, data, clock, now, after, size=(1080, 1920)):
    if headers.get("content-type") != "image/png" or not headers.get("etag"):
        raise ValueError("Camera frame is missing PNG type or ETag")
    phone_ms = float(headers.get("x-capture-ms", "nan"))
    if not math.isfinite(phone_ms):
        raise ValueError("Camera frame is missing its capture timestamp")
    stamp, error = clock.convert(phone_ms)
    if phone_ms <= after or not -error <= now - stamp <= FRESH_MS - error:
        return None
    check_png(data, size)
    return Frame(stamp, error, phone_ms, headers["etag"], data)


def match_pair(frames_a, frames_b, now):
    for frames in (frames_a, frames_b):
        while frames and now - frames[0].stamp + frames[0].error > FRESH_MS:
            frames.popleft()
    for a in reversed(frames_a):
        if not frames_b:
            break

        def skew(b):
            return abs(a.stamp - b.stamp) + a.error + b.error

        b = min(frames_b, key=skew)
        if skew(b) <= PAIR_MS:
            for frames, chosen in ((frames_a, a), (frames_b, b)):
                while frames and frames[0].stamp <= chosen.stamp:
                    frames.popleft()
            return a, b
    return None


class Camera:
    def __init__(self, serial, resolution="1080x1920"):
        self.size = tuple(map(int, resolution.split("x")))
        self.path = "/frame/480x640" if resolution == "480x640" else "/frame"
        self.serial = serial
        self.frames = deque(maxlen=3)
        self.reset()

    def reset(self):
        self.frames.clear()
        self.clock = None
        self.tag = None
        self.after = -math.inf

    def poll(self):
        if self.clock is None or monotonic_ms() - self.clock.midpoint > 10_000:
            clock = sync_clock(self.serial)
            if self.clock is not None:
                elapsed = abs(clock.midpoint - self.clock.midpoint)
                drift_bound = clock.half_rtt + self.clock.half_rtt + elapsed * 0.0001 + 2
                if abs(clock.offset - self.clock.offset) > drift_bound:
                    raise OSError("Phone clock changed. Establishing a fresh time reference.")
            if self.clock is None:
                # Require a capture made after this connection's clock handshake.
                self.after = monotonic_ms() - clock.offset + clock.half_rtt + 1
            self.clock = clock
        options = {"If-None-Match": self.tag} if self.tag else {}
        status, meta, body = request(
            PhoneConnection(self.serial), "GET", self.path, MAX_PNG, headers=options
        )
        if status in (204, 304):
            return
        if status != 200:
            raise OSError(f"Phone /frame returned HTTP {status}. Check the camera app.")
        if self.tag and meta.get("etag") == self.tag:
            return
        frame = decode_frame(meta, body, self.clock, monotonic_ms(), self.after, self.size)
        self.tag = meta.get("etag")
        if frame:
            self.frames.append(frame)
            self.after = frame.phone_ms


class Dashboard:
    def __init__(self, port):
        self.port = port
        self.tokens = {}
        self.source = None

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=TIMEOUT)
        status, _, data = request(conn, method, path, 8192, body, headers)
        if not 200 <= status < 300:
            raise ValueError(f"Dashboard HTTP {status}: {data.decode(errors='replace')[:240]}")
        return data

    def join(self, side, code):
        data = {"code": code, "expectedSlot": side}
        if self.source is not None:
            data["expectedSourceID"] = self.source
        result = json.loads(
            self.call("POST", "/api/join", json.dumps(data), {"Content-Type": "application/json"})
        )
        self.tokens[side] = result["token"]
        if result.get("slot") != side or not result.get("sourceID"):
            raise ValueError(
                "Start the current dashboard server with wired camera binding support."
            )
        if self.source is not None and self.source != result["sourceID"]:
            raise ValueError("Generate both pairing codes from the same dashboard.")
        self.source = result["sourceID"]

    def publish(self, pair):
        # Both timestamps share one Mac epoch conversion. Publish B first because
        # the dashboard selects a partner for the latest A from B's history.
        epoch_offset = time.time_ns() / 1_000_000 - monotonic_ms()
        for side, frame in zip(("B", "A"), reversed(pair)):
            if monotonic_ms() - frame.stamp + frame.error > FRESH_MS:
                return False
            self.call(
                "PUT",
                "/api/frame",
                frame.body,
                {
                    "Authorization": "Bearer " + self.tokens[side],
                    "Content-Type": "image/png",
                    "X-Sample-Ms": str(round(frame.stamp + epoch_offset)),
                    "X-Clock-Error-Ms": str(frame.error),
                },
            )
        return True

    def close(self):
        for token in self.tokens.values():
            try:
                self.call("DELETE", "/api/frame", headers={"Authorization": "Bearer " + token})
            except (OSError, ValueError, http.client.HTTPException) as error:
                print(f"Camera slot cleanup: {error}", file=sys.stderr)


def stream(cameras, dashboard, publish_interval=0, parent_pid=None):
    count, last_report = 0, monotonic_ms()
    next_publish = 0
    last_error = None
    with ThreadPoolExecutor(2) as pool:
        while parent_pid is None or os.getppid() == parent_pid:
            started = monotonic_ms()
            requests = [pool.submit(cam.poll) for cam in cameras]
            # Drain both futures before clearing state or beginning a new poll.
            errors = [future.exception() for future in requests]
            failed = next((err for err in errors if err is not None), None)
            if failed:
                if not isinstance(failed, (OSError, http.client.HTTPException)):
                    raise failed
                if str(failed) != last_error:
                    print(
                        f"{failed} Retrying the selected USB cameras.", file=sys.stderr, flush=True
                    )
                last_error = str(failed)
                for cam in cameras:
                    cam.reset()
                time.sleep(0.5)
                continue
            last_error = None
            pair = match_pair(cameras[0].frames, cameras[1].frames, monotonic_ms())
            if pair and monotonic_ms() >= next_publish and dashboard.publish(pair):
                count += 1
                next_publish = monotonic_ms() + publish_interval * 1000
            now = monotonic_ms()
            if now - last_report >= 5000:
                print(
                    f"{count} synchronized pairs uploaded in {(now-last_report)/1000:.1f}s."
                    + (
                        ""
                        if count
                        else " Keep both camera apps open and check cables and frame rate."
                    ),
                    flush=True,
                )
                count, last_report = 0, now
            time.sleep(max(0, 0.025 - (now - started) / 1000))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="list cabled device serials")
    run = commands.add_parser("capture", help="stream from two USB iPhones")
    run.add_argument("--resolution", choices=["480x640", "1080x1920"], default="1080x1920")
    run.add_argument("--managed", action="store_true", help=argparse.SUPPRESS)
    run.add_argument("--a", required=True, help="Camera A serial from list")
    run.add_argument("--b", required=True, help="Camera B serial from list")
    run.add_argument("--publish-interval", type=float, default=0,
                     help="Minimum seconds between dashboard pairs for slower depth workers")
    run.add_argument(
        "--dashboard-port", type=int, default=8775, help="local server port (default 8775)"
    )
    args = parser.parse_args()
    parent_pid = os.getppid() if getattr(args, "managed", False) else None
    devices = list_devices()
    if args.command == "list":
        print(
            "\n".join(sorted(devices))
            or "No USB devices found. Unlock each iPhone, trust this Mac, and check its data cable."
        )
        return
    if args.a == args.b:
        parser.error("A and B require different USB devices")
    if not math.isfinite(args.publish_interval) or args.publish_interval < 0:
        parser.error("Publish interval must be finite and nonnegative")
    if not 1 <= args.dashboard_port <= 65535:
        parser.error("Dashboard port must be between 1 and 65535")
    for serial in (args.a, args.b):
        if serial not in devices:
            parser.error(f"{serial} is missing. Use list and select an attached USB device.")
    dashboard = Dashboard(args.dashboard_port)
    try:
        if args.managed:
            dashboard.tokens = json.loads(sys.stdin.readline(512))
            if set(dashboard.tokens) != {"A", "B"}:
                parser.error("Missing dashboard credentials")
        else:
            codes = [getpass.getpass(f"Dashboard Camera {side} pairing code: ").strip() for side in "AB"]
            if codes[0] == codes[1] or not all(re.fullmatch(r"[0-9]{6}", code) for code in codes):
                parser.error("Enter two different six-digit dashboard codes in A, B order")
            for side, code in zip("AB", codes):
                dashboard.join(side, code)
        print("Paired. Keep the camera apps open. Press Ctrl-C to end capture.", flush=True)
        stream([Camera(args.a,args.resolution), Camera(args.b,args.resolution)], dashboard, args.publish_interval, parent_pid)
    finally:
        dashboard.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, KeyError, EOFError, http.client.HTTPException) as exc:
        sys.exit(f"Wired capture: {exc}. Check USB access and the local dashboard port.")
