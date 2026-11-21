"""Fuse spatial observations into conservative, per-sign temporal events."""

from collections import Counter, deque
from dataclasses import dataclass, field, replace
from statistics import mean
import re

from .schemas import Box, Observation, number
from .sign_grouping import group_signs
from .studyroom_temporal import candidate_room
from .text_normalization import DEFAULT_SHORT_SIGNS, classify, normalize_text, similarity
from .text_tracking import TextTracker


@dataclass(frozen=True)
class Settings:
    window_seconds: float = 4.0
    min_support_frames: int = 2
    min_ocr_confidence: float = 0.60
    min_confidence: float = 0.75
    min_match_similarity: float = 0.88
    max_gap_seconds: float = 2.5
    track_cooldown_seconds: float = 10.0
    safety_support_frames: int = 3
    safety_confidence: float = 0.85
    short_signs: frozenset = DEFAULT_SHORT_SIGNS
    legacy_gxx: bool = False

    def __post_init__(self):
        for value in (self.window_seconds, self.max_gap_seconds, self.track_cooldown_seconds):
            if not number(value) or value <= 0:
                raise ValueError('time settings must be positive')
        for value in (self.min_ocr_confidence, self.min_confidence, self.min_match_similarity, self.safety_confidence):
            if not number(value) or not 0 < value <= 1:
                raise ValueError('confidence and similarity settings must be between 0 and 1')
        if (type(self.min_support_frames) is not int or type(self.safety_support_frames) is not int
                or not 2 <= self.min_support_frames <= self.safety_support_frames
                or self.safety_confidence < self.min_confidence):
            raise ValueError('safety thresholds must be at least as strong as ordinary thresholds')


@dataclass(frozen=True)
class Sample:
    timestamp: float
    keys: tuple
    lines: tuple
    confidence: float
    box: Box
    relation: dict | None

    @classmethod
    def from_group(cls, group, timestamp):
        entries = [normalize_text(t.observation.text) for t in group.lines]
        box = group.lines[0].observation.box
        for track in group.lines[1:]:
            box = box.union(track.observation.box)
        return cls(timestamp, tuple(key for key, _ in entries), tuple(display for _, display in entries),
                   min(t.observation.confidence for t in group.lines), box, group.relation)


@dataclass
class SignTrack:
    id: str
    samples: deque = field(default_factory=deque)
    last_confirmed: float = float('-inf')
    confirmed_keys: tuple = ()
    uncertain: bool = False


@dataclass
class CameraState:
    tracker: TextTracker
    stream_id: str | None = None
    size: tuple | None = None
    last_timestamp: float = float('-inf')
    sequence: int = 0
    signs: dict = field(default_factory=dict)


class TemporalSignFilter:
    def __init__(self, settings=None):
        self.settings = settings or Settings()
        self.cameras = {}

    def _match(self, left, right):
        return len(left) == len(right) and all(similarity(a, b, self.settings.min_match_similarity) for a, b in zip(left, right))

    def _event(self, state, track, line_ids, sample, evidence, status, timestamp):
        kinds = [classify(key, self.settings.short_signs) for key in sample.keys]
        if status != 'confirmed':
            relation = {'relationship': 'unknown'}
        elif sample.relation and all(s.relation and s.relation['direction'] == sample.relation['direction'] for s in evidence):
            relation = {**sample.relation, 'confidence': round(mean(s.relation['confidence'] for s in evidence), 3)}
        else:
            relation = {'relationship': 'unknown'}
        kind = 'directional_sign' if sample.relation else 'notice' if len(kinds) > 1 or kinds[0] == 'long_text' else kinds[0]
        return {
            'camera_id': state.tracker.camera_id, 'stream_id': state.stream_id, 'timestamp_seconds': timestamp,
            'event_type': status + '_sign', 'track_id': track.id, 'sign_type': kind, 'status': status,
            'lines': [{'text': text, 'line_track_id': line} for text, line in zip(sample.lines, line_ids)],
            'spatial_relation': relation, 'support_frames': len(evidence),
            'confidence': round(mean(s.confidence for s in evidence), 4),
            'bbox_normalized': sample.box.normalized(state.size),
            'bbox_pixels': [sample.box.left, sample.box.top, sample.box.right, sample.box.bottom],
            'warning': 'OCR interpretation; not verified navigation guidance',
        }

    def _update_group(self, state, line_ids, sample):
        settings = self.settings
        if line_ids not in state.signs:
            state.sequence += 1
            state.signs[line_ids] = SignTrack(f'{state.tracker.camera_id}-sign-{state.sequence:04d}')
        track = state.signs[line_ids]
        if sample.confidence < settings.min_ocr_confidence:
            return None, 'low_confidence'
        track.samples.append(sample)
        evidence = [item for item in track.samples if self._match(item.keys, sample.keys)]
        exact_support = Counter(item.keys for item in evidence)
        variants = list(exact_support)
        if len(evidence) != len(track.samples) or any(
            not self._match(a, b) for index, a in enumerate(variants) for b in variants[index + 1:]
        ):
            event = None if track.uncertain else self._event(state, track, line_ids, sample, evidence, 'uncertain', sample.timestamp)
            track.uncertain = True
            return event, 'conflicting_text'
        track.uncertain = False
        safety = any(classify(key) == 'direction' or re.search(r'\b(?:left|right|exit|entry|emergency)\b|出口|入口', key)
                     for key in sample.keys)
        required_frames = settings.safety_support_frames if safety else settings.min_support_frames
        required_confidence = settings.safety_confidence if safety else settings.min_confidence
        if len(evidence) < required_frames or mean(s.confidence for s in evidence) < required_confidence:
            return None, 'provisional'
        if (track.confirmed_keys and self._match(track.confirmed_keys, sample.keys)) or (
            sample.timestamp - track.last_confirmed < settings.track_cooldown_seconds
        ):
            return None, 'already_confirmed'
        best = max(evidence, key=lambda item: (exact_support[item.keys], item.confidence, item.timestamp))
        # Keep the visible frame's geometry while selecting the strongest observed wording.
        chosen = Sample(sample.timestamp, best.keys, best.lines, sample.confidence, sample.box, best.relation)
        track.last_confirmed = sample.timestamp
        track.confirmed_keys = best.keys
        return self._event(state, track, line_ids, chosen, evidence, 'confirmed', sample.timestamp), 'confirmed'

    def update(self, frame, camera_id='A', stream_id=None, size=None):
        timestamp = frame.get('time_seconds') if isinstance(frame, dict) else None
        if not number(timestamp) or timestamp < 0:
            return [], {'status': 'invalid_timestamp'}
        if camera_id not in self.cameras:
            self.cameras[camera_id] = CameraState(TextTracker(camera_id, self.settings.max_gap_seconds,
                                                             self.settings.min_match_similarity), stream_id, size)
        state = self.cameras[camera_id]
        lost_on_reset = []
        if (state.stream_id, state.size) != (stream_id, size):
            lost_on_reset = state.tracker.reset()
            state.stream_id, state.size = stream_id, size
            state.signs.clear()
            state.last_timestamp = float('-inf')
        if timestamp <= state.last_timestamp:
            return [], {'status': 'non_increasing_timestamp', 'timestamp_seconds': timestamp}
        state.last_timestamp = timestamp

        observations, skipped, corrections = [], [], []
        detections = frame.get('detections', [])
        if not isinstance(detections, list):
            detections = []
            skipped.append({'reason': 'detections must be an array'})
        for index, item in enumerate(detections):
            try:
                observation = Observation.parse(item, size)
            except ValueError as error:
                skipped.append({'index': index, 'reason': str(error)})
                continue
            parsed = candidate_room(observation.text) if self.settings.legacy_gxx else None
            if self.settings.legacy_gxx and not parsed:
                skipped.append({'index': index, 'reason': 'outside known Gxx profile'})
                continue
            if parsed and parsed[0] != observation.text:
                code, edits = parsed
                corrections.append({'index': index, 'raw_text': observation.text, 'corrected_text': code})
                observation = replace(observation, text=code, confidence=max(0, observation.confidence - 0.12 * edits))
            observations.append(observation)
        distinct = []
        for item in sorted(observations, key=lambda o: -o.confidence):
            if not any(normalize_text(o.text)[0] == normalize_text(item.text)[0] and o.box.iou(item.box) >= 0.85 for o in distinct):
                distinct.append(item)
        visible, lifecycle = state.tracker.update(distinct, timestamp)
        lifecycle['lost'] = lost_on_reset + lifecycle['lost']
        for line_ids, track in list(state.signs.items()):
            if any(line not in state.tracker.tracks for line in line_ids):
                del state.signs[line_ids]
                continue
            while track.samples and timestamp - track.samples[0].timestamp > self.settings.window_seconds:
                track.samples.popleft()
        events, groups = [], []
        for group in group_signs(visible, self.settings.short_signs):
            line_ids = tuple(t.id for t in group.lines)
            sample = Sample.from_group(group, timestamp)
            event, status = self._update_group(state, line_ids, sample)
            if event:
                events.append(event)
            groups.append({'track_id': state.signs[line_ids].id, 'line_track_ids': line_ids, 'lines': sample.lines,
                           'status': status, 'spatial_relation': sample.relation or {'relationship': 'unknown'}})
        return events, {'status': 'processed', 'timestamp_seconds': timestamp, 'camera_id': camera_id,
                        'stream_id': stream_id, 'regions': lifecycle, 'skipped': skipped, 'corrections': corrections,
                        'groups': groups, 'visible_lines': [
                            {'line_track_id': t.id, 'text': t.observation.text, 'confidence': t.observation.confidence,
                             'polygon': t.observation.polygon, 'centroid': t.observation.box.center,
                             'orientation_degrees': round(t.observation.orientation_degrees, 2)} for t in visible
                        ]}
