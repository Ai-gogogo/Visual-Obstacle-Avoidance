"""Time CPU semantic voting on deterministic 480 × 640 connected components."""
import argparse
import csv
from pathlib import Path
from time import perf_counter_ns
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

import obstacles
from geometry import ground_axes


def fixture(rows, columns):
    height, width = 640, 480
    shape = (height, width)
    focal = 420.
    camera = (np.array([[focal, 0, width/2], [0, focal, height/2], [0, 0, 1.]]), np.zeros(5))
    normal = np.array([0., -1., 0.])
    plane = SimpleNamespace(validated=True, normal=normal, d=.55, holdout_p90_m=.01)
    depth = np.full(shape, np.nan, dtype=np.float32)
    depth[460:] = .55 * focal / (np.arange(460, height)[:, None] - height/2)
    semantic_map = np.full(shape, obstacles.SEMANTIC_UNKNOWN_ID, dtype=np.uint8)
    rng = np.random.default_rng(20261121)
    for row in range(rows):
        for col in range(columns):
            y, x = 470 + 52*row, 155 + 43*col
            region = np.s_[y:y+40, x:x+30]
            depth[region] *= .7
            confidence = rng.random((40, 30))
            semantic_map[region] = np.where(confidence < .6, 3, np.where(confidence < .8, 5, 255))
    return depth, camera, plane, np.ones(shape, bool), obstacles.PlaneObstacles(), ground_axes(normal), semantic_map


def samples(rows, columns, repeats):
    *geometry, semantic_map = fixture(rows, columns)
    vote = obstacles.vote_static_class
    with patch("obstacles.vote_static_class", wraps=vote) as recorder:
        result = obstacles.unclassified_obstacles(*geometry, semantic_map=semantic_map)
    if len(result) != rows * columns or any(obj["semantic_label"] != "wall" for obj in result):
        raise ValueError("Benchmark fixture did not yield the intended labelled obstacles")
    components = [call.args for call in recorder.call_args_list]
    pixels = sum(np.count_nonzero(selection) for _, selection in components)
    for _ in range(50):
        for region, selection in components:
            vote(region, selection)
    timings = []
    for _ in range(repeats):
        start = perf_counter_ns()
        for region, selection in components:
            vote(region, selection)
        timings.append((perf_counter_ns() - start) / 1e6)
    return len(components), pixels, timings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--repeats", type=int, default=1200)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    cv2.setNumThreads(1)
    with args.output.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(("components", "component_pixels", "repeat", "cpu_vote_ms"))
        for rows, columns in ((1, 2), (3, 4)):
            count, pixels, elapsed = samples(rows, columns, args.repeats)
            writer.writerows((count, pixels, i, ms) for i, ms in enumerate(elapsed, 1))
            median, p95 = np.percentile(elapsed, [50, 95])
            print(f"{count} components, {pixels} pixels, {len(elapsed)} repeats: "
                  f"mean {np.mean(elapsed):.4f} ms, median {median:.4f} ms, P95 {p95:.4f} ms")


if __name__ == "__main__":
    main()
