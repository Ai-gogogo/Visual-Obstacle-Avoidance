"""Three uniquely coded ChArUco faces on a rectangular box, in front/right/top order."""
import json
from functools import lru_cache

import cv2
import numpy as np

FACES = ("front", "right", "top")
COLS, ROWS = 8, 6
CORNERS = (COLS - 1) * (ROWS - 1)


@lru_cache(maxsize=3)
def board(face):
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_100)
    count = COLS * ROWS // 2
    ids = np.arange(face * count, (face + 1) * count, dtype=np.int32)
    return cv2.aruco.CharucoBoard((COLS, ROWS), 1.0, 0.68, dictionary, ids)


@lru_cache(maxsize=3)
def detector(face):
    return cv2.aruco.CharucoDetector(board(face))


def detect(image):
    points = {}
    for face in range(len(FACES)):
        corners, ids, _, _ = detector(face).detectBoard(image)
        if ids is not None:
            points.update((face * CORNERS + int(i), pt) for i, pt in
                          zip(ids.ravel(), corners.reshape(-1, 2)))
    return points


def shared_faces(left, right):
    ids = np.array(sorted(left.keys() & right.keys()), dtype=np.int32)
    groups = []
    for face in range(len(FACES)):
        group = ids[ids // CORNERS == face]
        if len(group) >= 6:
            xy = board(face).getChessboardCorners()[group % CORNERS, :2]
            if np.linalg.matrix_rank(xy - xy[0]) == 2:
                groups.append(group)
    return np.concatenate(groups) if groups else np.empty(0, dtype=np.int32)


def read_layout(path):
    raw = json.loads(path.read_text())
    layout = []
    for name in FACES:
        try:
            face = raw[name]
            values = [float(face[k]) for k in ("five_squares_mm", "horizontal_gap_mm", "vertical_gap_mm")]
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"Enter measured five_squares_mm and both grid-to-seam gaps for {name}") from error
        if not np.isfinite(values).all() or values[0] <= 0 or min(values[1:]) < 0:
            raise ValueError(f"Invalid measurements for {name}")
        layout.append(values)
    return layout


def object_points(ids, layout):
    """Origin at the common top/front/right corner. Units returned in meters."""
    result = np.empty((len(ids), 3), dtype=np.float32)
    for f, (five, horizontal, vertical) in enumerate(layout):
        select = ids // CORNERS == f
        uv = board(f).getChessboardCorners()[ids[select] % CORNERS, :2]
        square = five / 5
        u, v = uv.T * square
        zero = np.zeros_like(u)
        if f == 0:  # right and top grid margins meet the common corner
            xyz = (u - COLS * square - horizontal, v + vertical, zero)
        elif f == 1:  # left and top
            xyz = (zero, v + vertical, u + horizontal)
        else:  # right and bottom; printed top edge points toward back of box
            xyz = (u - COLS * square - horizontal, zero, ROWS * square - v + vertical)
        result[select] = np.column_stack(xyz) / 1000
    return result
