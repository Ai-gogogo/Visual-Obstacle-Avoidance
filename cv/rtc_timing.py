"""Map decoded video PTS to the sender clock using RTCP sender reports."""
from collections import OrderedDict
from fractions import Fraction
import re
import time

from aiortc.clock import datetime_from_ntp
from aiortc.rtp import RtcpSrPacket

VIDEO_TIME_BASE = Fraction(1, 90_000)
MAX_REPORT_AGE_MS = 4_000


def ticks_between(a, b):
    return ((a - b + (1 << 31)) % (1 << 32)) - (1 << 31)


def video_ssrc(sdp):
    fid = re.search(r"(?m)^a=ssrc-group:FID (\d+) \d+\s*$", sdp)
    sources = set(re.findall(r"(?m)^a=ssrc:(\d+) ", sdp))
    if fid and int(fid[1]) in {int(source) for source in sources}:
        return int(fid[1])
    if len(sources) == 1:
        return int(sources.pop())
    return None


class CaptureTimeline:
    def __init__(self):
        self.pts_to_rtp = OrderedDict()
        self.report = None
        self.error_ms = None

    def remember_rtp(self, pts, rtp):
        self.pts_to_rtp[pts] = rtp
        if len(self.pts_to_rtp) > 180:
            self.pts_to_rtp.popitem(last=False)

    def update_report(self, rtp, sender_ms, now_ms):
        if self.report:
            previous_rtp, previous_ms, previous_now = self.report
            elapsed = sender_ms - previous_ms
            if elapsed == 0:
                return
            residual = abs(elapsed - ticks_between(rtp, previous_rtp) / 90)
            self.error_ms = (max(4, round(residual + 2))
                             if 100 <= elapsed <= MAX_REPORT_AGE_MS
                             and now_ms - previous_now <= MAX_REPORT_AGE_MS
                             and residual <= 8 else None)
        self.report = (rtp, sender_ms, now_ms)

    def estimate(self, frame, now_ms):
        if self.error_ms is None or frame.time_base != VIDEO_TIME_BASE:
            return None
        rtp = self.pts_to_rtp.get(frame.pts)
        if rtp is None:
            return None
        anchor_rtp, sender_ms, anchor_received = self.report
        elapsed_ms = ticks_between(rtp, anchor_rtp) / 90
        if now_ms - anchor_received > MAX_REPORT_AGE_MS or abs(elapsed_ms) > MAX_REPORT_AGE_MS:
            return None
        return round(sender_ms + elapsed_ms), self.error_ms + round(abs(elapsed_ms) / 1000)

    def attach(self, receiver, ssrc):
        if ssrc is None:
            return
        # aiortc 1.16 normalizes RTP timestamps before passing PTS to PyAV.
        # Observe this exact mapping rather than inferring it from packet arrivals.
        mapper = getattr(receiver, "_RTCRtpReceiver__timestamp_mapper", None)
        if mapper is None:
            return
        original_map = mapper.map
        handle_rtcp = receiver._handle_rtcp_packet

        def map_timestamp(rtp):
            pts = original_map(rtp)
            self.remember_rtp(pts, rtp)
            return pts

        async def receive_rtcp(packet):
            if isinstance(packet, RtcpSrPacket) and packet.ssrc == ssrc:
                info = packet.sender_info
                if info.ntp_timestamp and info.packet_count:
                    sender_ms = datetime_from_ntp(info.ntp_timestamp).timestamp() * 1000
                    self.update_report(info.rtp_timestamp, sender_ms, time.monotonic_ns() // 1_000_000)
            await handle_rtcp(packet)

        mapper.map = map_timestamp
        receiver._handle_rtcp_packet = receive_rtcp
