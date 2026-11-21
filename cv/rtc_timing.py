"""Map decoded video PTS to the sender clock using RTCP sender reports."""
from collections import OrderedDict, deque
from fractions import Fraction
import re
import time

from aiortc.clock import datetime_from_ntp
from aiortc.rtp import RtcpPacket, RtcpRrPacket, RtcpSrPacket

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
        self.probes = OrderedDict()
        self.offsets = deque(maxlen=24)
        self.debug = dict(probe=False, sent=0, sr=0, rr=0, echoes=0, accepted=0)

    def note_echo(self, lsr, delay, remote_ms, now_mono, now_wall):
        sent = self.probes.get(lsr)
        if sent is None:
            return
        self.debug["echoes"] += 1
        # DLSR is the phone's wait between receiving our SR and sending its
        # report. The remaining round trip bounds the unknown return delay.
        network = now_mono - sent - delay * 1000 / 65536
        self.debug["rtt_ms"] = round(network)
        if 0 <= network <= 50:
            self.debug["accepted"] += 1
            self.offsets.append((now_mono, now_wall - network/2 - remote_ms,
                                 int(network/2 + 2)))

    def media_clock(self, now):
        fresh = [s for s in self.offsets if now-s[0] < 10000]
        if len(fresh) < 2:
            return None
        # Two independent echoes must agree within both uncertainty bounds.
        recent = fresh[-1]
        other = [s for s in fresh[:-1] if abs(s[1]-recent[1]) <= s[2]+recent[2]]
        if other:
            _, offset, error = min([recent, *other], key=lambda s:s[2])
            return round(offset), error+1

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

    def attach(self, receiver, ssrc, sender=None):
        if ssrc is None:
            return
        # aiortc 1.16 normalizes RTP timestamps before passing PTS to PyAV.
        # Observe this exact mapping rather than inferring it from packet arrivals.
        mapper = getattr(receiver, "_RTCRtpReceiver__timestamp_mapper", None)
        if mapper is None:
            return
        original_map = mapper.map
        handle_rtcp = receiver._handle_rtcp_packet
        if sender is not None:
            self.debug["probe"] = True
            send = sender._send_rtcp

            async def send_probe(packets):
                for packet in packets:
                    if isinstance(packet, RtcpSrPacket) and packet.sender_info.packet_count:
                        self.debug["sent"] += 1
                        token = (packet.sender_info.ntp_timestamp >> 16) & 0xffffffff
                        self.probes[token] = time.monotonic_ns() / 1e6
                        if len(self.probes)>32:
                            self.probes.popitem(last=False)
                await send(packets)
            sender._send_rtcp = send_probe
            # A compound datagram may put the echoed report block in a
            # separate RR beside the SR. Match only within that datagram.
            transport = receiver.transport
            handle_data = transport._handle_rtcp_data

            async def observe_reports(data):
                mono, wall = time.monotonic_ns()/1e6, time.time_ns()/1e6
                try:
                    packets = RtcpPacket.parse(data)
                except ValueError:
                    packets = []
                reports = [p for p in packets if isinstance(p, (RtcpRrPacket, RtcpSrPacket))]
                self.debug["rr"] += sum(isinstance(p,RtcpRrPacket) for p in reports)
                for p in reports:
                    if isinstance(p,RtcpSrPacket) and p.ssrc == ssrc and p.sender_info.ntp_timestamp:
                        self.debug["sr"] += 1
                        remote = datetime_from_ntp(p.sender_info.ntp_timestamp).timestamp()*1000
                        self.debug["sr_lag_ms"] = round(wall-remote)
                        for report in reports:
                            for block in report.reports:
                                if block.ssrc == sender._ssrc and block.lsr:
                                    self.note_echo(block.lsr, block.dlsr, remote, mono, wall)
                await handle_data(data)
            transport._handle_rtcp_data = observe_reports

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
