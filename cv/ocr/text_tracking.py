"""Assign one observation per frame to a physical text region."""

from dataclasses import dataclass
from math import hypot

from .schemas import Observation
from .text_normalization import normalize_text, similarity


@dataclass
class Track:
    id: str
    observation: Observation
    last_seen: float
    velocity: tuple = (0.0, 0.0)
    state: str = 'visible'

    def move(self, observation, timestamp):
        old_x, old_y = self.observation.box.center
        x, y = observation.box.center
        gap = timestamp - self.last_seen
        self.velocity = (x - old_x) / gap, (y - old_y) / gap
        self.observation = observation
        self.last_seen = timestamp
        self.state = 'visible'


class TextTracker:
    def __init__(self, camera_id, max_gap_seconds=2.5, min_similarity=0.88):
        self.camera_id = camera_id
        self.max_gap = max_gap_seconds
        self.min_similarity = min_similarity
        self.tracks = {}
        self.sequence = 0

    def _cost(self, track, observation, timestamp):
        previous = track.observation.box
        current = observation.box
        gap = timestamp - track.last_seen
        predicted = previous.shift(*(v * gap for v in track.velocity))
        distance = hypot(*(a - b for a, b in zip(predicted.center, current.center)))
        original_distance = hypot(*(a - b for a, b in zip(previous.center, current.center)))
        size = max(previous.height, current.height, 8)
        overlap = predicted.iou(current)
        if (overlap < 0.15 and distance > 1.6 * size) or original_distance > max(5 * size, previous.width):
            return None
        quality = similarity(normalize_text(track.observation.text)[0], normalize_text(observation.text)[0],
                             self.min_similarity)
        if not quality and overlap < 0.25 and previous.iou(current) < 0.25:
            return None
        return 0.40 * (1 - overlap) + 0.28 * min(1, distance / (2 * size)) + 0.27 * (1 - quality) + 0.05 * gap / self.max_gap

    def reset(self):
        lost = sorted(self.tracks)
        self.tracks.clear()
        return lost

    def update(self, observations, timestamp):
        lost = sorted(key for key, track in self.tracks.items() if timestamp - track.last_seen > self.max_gap)
        for key in lost:
            del self.tracks[key]
        pairs = []
        for key, track in self.tracks.items():
            for index, observation in enumerate(observations):
                cost = self._cost(track, observation, timestamp)
                if cost is not None:
                    pairs.append((cost, key, index))
        used_tracks, used_observations = set(), set()
        for _, key, index in sorted(pairs):
            if key in used_tracks or index in used_observations:
                continue
            self.tracks[key].move(observations[index], timestamp)
            used_tracks.add(key)
            used_observations.add(index)
        started, occluded = [], []
        for key, track in self.tracks.items():
            if key not in used_tracks and track.state != 'occluded':
                track.state = 'occluded'
                occluded.append(key)
        for index, observation in enumerate(observations):
            if index in used_observations:
                continue
            self.sequence += 1
            key = f'{self.camera_id}-line-{self.sequence:04d}'
            self.tracks[key] = Track(key, observation, timestamp)
            started.append(key)
        visible = [track for track in self.tracks.values() if track.state == 'visible']
        return visible, {'started': started, 'occluded': occluded, 'lost': lost}
