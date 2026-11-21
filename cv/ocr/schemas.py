"""Pixel geometry and validated frame observations for offline OCR."""

from dataclasses import dataclass
from math import atan2, degrees, hypot, isfinite


@dataclass(frozen=True)
class Box:
    left: float
    top: float
    right: float
    bottom: float

    @property
    def width(self):
        return self.right - self.left

    @property
    def height(self):
        return self.bottom - self.top

    @property
    def center(self):
        return (self.left + self.right) / 2, (self.top + self.bottom) / 2

    def iou(self, other):
        area = max(0, min(self.right, other.right) - max(self.left, other.left)) * max(
            0, min(self.bottom, other.bottom) - max(self.top, other.top))
        return area / (self.width * self.height + other.width * other.height - area)

    def shift(self, dx, dy):
        return Box(self.left + dx, self.top + dy, self.right + dx, self.bottom + dy)

    def union(self, other):
        return Box(min(self.left, other.left), min(self.top, other.top),
                   max(self.right, other.right), max(self.bottom, other.bottom))

    def normalized(self, size):
        if size is None:
            return None
        width, height = size
        return [round(value, 6) for value in (self.left / width, self.top / height,
                                             self.right / width, self.bottom / height)]


def number(value):
    return type(value) in (int, float) and isfinite(value)


def polygon_geometry(points, size=None):
    if not isinstance(points, (list, tuple)) or len(points) != 4:
        raise ValueError('expected four polygon corners')
    if any(not isinstance(p, (list, tuple)) or len(p) != 2 or not all(map(number, p)) for p in points):
        raise ValueError('invalid polygon coordinates')
    if any(x < 0 or y < 0 or (size and (x > size[0] or y > size[1])) for x, y in points):
        raise ValueError('polygon outside image bounds')
    cx, cy = (sum(axis) / 4 for axis in zip(*points))
    ordered = sorted(points, key=lambda p: atan2(p[1] - cy, p[0] - cx))
    edges = [(q[0] - p[0], q[1] - p[1]) for p, q in zip(ordered, ordered[1:] + ordered[:1])]
    if any(x * ny - y * nx <= 0 for (x, y), (nx, ny) in zip(edges, edges[1:] + edges[:1])):
        raise ValueError('polygon must form a convex quadrilateral')
    area = abs(sum(x * ny - y * nx for (x, y), (nx, ny) in zip(ordered, ordered[1:] + ordered[:1]))) / 2
    if area < 16:
        raise ValueError('polygon is too small')
    xs, ys = zip(*ordered)
    dx, dy = max(edges, key=lambda edge: hypot(*edge))
    angle = (degrees(atan2(dy, dx)) + 90) % 180 - 90
    return Box(min(xs), min(ys), max(xs), max(ys)), tuple(map(tuple, ordered)), angle


def polygon_box(points, size=None):
    return polygon_geometry(points, size)[0]


@dataclass(frozen=True)
class Observation:
    text: str
    confidence: float
    box: Box
    polygon: tuple
    orientation_degrees: float

    @classmethod
    def parse(cls, data, size=None):
        if not isinstance(data, dict) or not isinstance(data.get('text'), str) or not data['text'].strip():
            raise ValueError('invalid OCR text')
        confidence = data.get('confidence')
        if not number(confidence) or not 0 <= confidence <= 1:
            raise ValueError('invalid OCR confidence')
        box, polygon, angle = polygon_geometry(data.get('polygon'), size)
        return cls(data['text'], confidence, box, polygon, angle)
