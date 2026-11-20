import io
import json
import plistlib
import socket
import struct
import unittest
import zlib
from unittest.mock import MagicMock, patch
from collections import deque

import capture as c


def png(width=1080, height=1920):
    def chunk(kind, data):
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes((width + 1) * height)))
        + chunk(b"IEND", b"")
    )


class CaptureTests(unittest.TestCase):
    def test_usb_pin(self):
        def device(serial, handle, medium):
            return {
                "DeviceID": handle,
                "Properties": {"SerialNumber": serial, "ConnectionType": medium},
            }

        records = [
            device("left", 1, "Network"),
            device("right", 2, "USB"),
            device("left", 3, "USB"),
        ]
        self.assertEqual(c.usb_devices(records), {"left": 3, "right": 2})
        with self.assertRaises(ValueError):
            c.usb_devices(records + [device("left", 4, "USB")])

    def test_lowest_rtt_calibration_and_age(self):
        clock = c.Clock.from_samples([(100, 1100, 106), (140, 1141, 142)])
        stamp, error = clock.convert(1150)
        self.assertEqual(stamp, 150)
        self.assertGreaterEqual(error, 2)
        self.assertGreater(clock.convert(21150)[1], error)
        with self.assertRaises(OSError):
            c.Clock.from_samples([(100, 1000, 200)])

    def test_capture_freshness_and_orientation(self):
        body = png()
        headers = {"content-type": "image/png", "etag": '"3"', "x-capture-ms": "1200"}
        clock = c.Clock.from_samples([(199, 1200, 201)])
        self.assertIsNotNone(c.decode_frame(headers, body, clock, now=210, after=1190))
        for now, after in [(2000, 1190), (210, 1200), (120, 1190)]:
            self.assertIsNone(c.decode_frame(headers, body, clock, now=now, after=after))
        with self.assertRaises(ValueError):
            c.decode_frame(headers, png(1920, 1080), clock, now=200, after=0)
        with self.assertRaises(ValueError):
            c.decode_frame(headers, body[:-3], clock, now=200, after=0)

    def test_match_uses_errors_and_freshness(self):
        def frame(stamp, error):
            return c.Frame(stamp, error, stamp, '"1"', b"")

        for b_time, accepted in [(1059, True), (1060, False), (10, False)]:
            side_a = deque([frame(1000, 2)])
            side_b = deque([frame(b_time, 4)])
            self.assertEqual(c.match_pair(side_a, side_b, now=1120) is not None, accepted)
        self.assertIsNone(c.match_pair(deque([frame(1000, 1)]), deque([frame(1002, 1)]), now=3000))

    def test_wire_exchange_never_selects_wireless_handle(self):
        def mux_reply(obj):
            body = plistlib.dumps(obj)
            return c.MUX_HEADER.pack(16 + len(body), 1, 8, 1) + body

        def scripted_channel(reply):
            sock = MagicMock()
            stream = io.BytesIO(reply)
            sock.recv.side_effect = stream.read
            return sock

        def device(handle, medium):
            return {
                "Properties": {"SerialNumber": "left", "ConnectionType": medium},
                "DeviceID": handle,
            }

        listing = scripted_channel(
            mux_reply({"DeviceList": [device(2, "Network"), device(7, "USB")]})
        )
        tunnel = scripted_channel(mux_reply({"MessageType": "Result", "Number": 0}))
        tunnel.makefile.return_value = io.BytesIO(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 15\r\n\r\n"
            + b'{"clockMs":123}'
        )
        with patch.object(c, "mux_socket", side_effect=[listing, tunnel]):
            status, _, data = c.request(c.PhoneConnection("left"), "GET", "/clock", 1024)
        self.assertEqual((status, json.loads(data)), (200, {"clockMs": 123}))
        record = plistlib.loads(tunnel.sendall.call_args_list[0].args[0][16:])
        self.assertEqual(
            (record["MessageType"], record["DeviceID"], record["PortNumber"]),
            ("Connect", 7, socket.htons(18875)),
        )
        self.assertTrue(tunnel.sendall.call_args_list[1].args[0].startswith(b"GET /clock HTTP/1.1"))

    def test_dashboard_owns_two_tokens_and_publishes_b_before_a(self):
        dash = c.Dashboard(8775)
        with patch.object(
            dash,
            "call",
            side_effect=[
                b'{"token":"left","slot":"A","sourceID":"desk"}',
                b'{"token":"right","slot":"B","sourceID":"desk"}',
                b"",
                b"",
                b"",
                b"",
            ],
        ) as call:
            dash.join("A", "123456")
            dash.join("B", "234567")
            self.assertEqual(
                json.loads(call.call_args.args[2]),
                {"code": "234567", "expectedSlot": "B", "expectedSourceID": "desk"},
            )
            start = c.monotonic_ms()
            frames = [c.Frame(start - n, 2, 10, '"1"', name) for n, name in [(3, b"a"), (4, b"b")]]
            self.assertTrue(dash.publish(frames))
            dash.close()
            put_b, put_a, del_a, del_b = call.call_args_list[2:]
            self.assertEqual([put_b.args[2], put_a.args[2]], [b"b", b"a"])
            self.assertEqual(put_b.args[3]["X-Clock-Error-Ms"], "2")
            self.assertEqual(
                int(put_a.args[3]["X-Sample-Ms"]) - int(put_b.args[3]["X-Sample-Ms"]), 1
            )
            self.assertEqual(
                [
                    del_a.kwargs["headers"]["Authorization"],
                    del_b.kwargs["headers"]["Authorization"],
                ],
                ["Bearer left", "Bearer right"],
            )

    def test_reset_discards_history_and_frames_from_before_reconnect(self):
        cam = c.Camera("left")
        cam.frames.append(c.Frame(99, 1, 99, '"old"', b""))
        cam.tag = '"old"'
        cam.reset()
        self.assertFalse(cam.frames)
        self.assertIsNone(cam.tag)
        headers = {"etag": '"stale"', "content-type": "image/png", "x-capture-ms": "1199"}
        with patch.object(c, "sync_clock", return_value=c.Clock(-1000, 200, 1)), patch.object(
            c, "monotonic_ms", return_value=200
        ), patch.object(c, "request", return_value=(200, headers, png())):
            cam.poll()
        self.assertFalse(cam.frames)


if __name__ == "__main__":
    unittest.main()
