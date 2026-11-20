"""Postprocess OCR text for room signs formatted G + two digits.
A character between G and the final two digits may be a decorative vertical bar.
No known room sequence is used to infer results.
"""
import re
from collections import Counter, deque

# Confusions observed in the supplied video. This is building-specific.
SEPARATORS = set('|!/\\ILJ1')
DIGITS = {'O':'0','Q':'0','D':'0','S':'5','B':'8'}


def candidate_room(text):
    """Return (room_code, edits) or None. Strict format: G + two digits.

    Supports an optional one-character decorative separator following G.
    Character 1 in this position is ambiguous in other buildings; restrict to
    this known Gxx sign style. No target room list or order is hard-coded.
    """
    s = re.sub(r'\s+', '', str(text)).upper()
    if not s:
        return None
    edits = 0
    # A common case: camera reads G as 6; only allow for 4-character strings.
    if len(s) == 4 and s[0] == '6':
        s = 'G' + s[1:]
        edits += 1
    if not s.startswith('G'):
        return None
    if len(s) == 4:
        if s[1] not in SEPARATORS:
            return None
        s = s[0] + s[2:]
        edits += 1
    if len(s) != 3:
        return None
    digits = ''
    for c in s[1:]:
        d = DIGITS.get(c, c)
        if not d.isdigit():
            return None
        edits += (c != d)
        digits += d
    return 'G' + digits, edits


class RoomTemporalFilter:
    """Vote across distinct frames; suppress repeats and reset after gaps."""
    def __init__(self, window=4, min_votes=2, cooldown=10.0, min_quality=0.55):
        if not (1 <= min_votes <= window):
            raise ValueError('Invalid votes/window')
        self.history = deque(maxlen=window)
        self.min_votes = min_votes
        self.cooldown = cooldown
        self.min_quality = min_quality
        self.last_emitted = {}

    def update(self, observations, timestamp):
        frame = {}
        for obs in observations:
            parsed = candidate_room(obs.get('text', ''))
            if not parsed:
                continue
            code, edits = parsed
            conf = obs.get('confidence')
            if conf is None:
                continue
            quality = max(0, float(conf) - 0.12 * edits)
            if quality >= self.min_quality:
                frame[code] = max(frame.get(code, 0), quality)
        self.history.append(frame)
        counts = Counter(code for f in self.history for code in f)
        events = []
        for code, votes in counts.items():
            if votes < self.min_votes or code not in frame:
                continue
            if timestamp - self.last_emitted.get(code, float('-inf')) < self.cooldown:
                continue
            self.last_emitted[code] = timestamp
            events.append({
                'room': code, 'time_seconds': round(float(timestamp), 2),
                'votes': votes,
                'mean_quality': round(sum(f.get(code, 0) for f in self.history) / votes, 3),
                'status': 'multi_frame_candidate_not_safety_verified'
            })
        return events
