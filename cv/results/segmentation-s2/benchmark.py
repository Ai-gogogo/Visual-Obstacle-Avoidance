"""Replay the first 37 pairs; time CPU object statistics separately from inference and plane fitting."""
import argparse
import csv
from pathlib import Path
from time import perf_counter_ns

import cv2
import numpy as np
from PIL import Image
import torch
from ultralytics import YOLO

from detect_image import DEFAULT_WEIGHTS, detect
from eval_plane_ransac import masks as plane_candidates, recording_rows
from mask_utils import InstanceMask
from plane_ransac import fit_support_plane, object_height_m
import raft_depth
from stereo_depth import StereoDepth, object_depth_stats


def measure(frame, camera, use_masks):
    depth, plane, objects = frame
    # Recreate the worker's per-frame masks for every timed invocation.
    regions = [(box, InstanceMask(mask) if use_masks else None) for box, mask in objects]
    distances = []
    for box, mask in regions:
        distances.append(object_depth_stats(depth, box, mask=mask))
    if plane.validated:
        for box, mask in regions:
            object_height_m(depth, camera, plane, box, mask=mask)
    return distances


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("calibration", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    torch.set_num_threads(4)
    cv2.setNumThreads(1)
    stereo = StereoDepth.load(args.calibration)
    if stereo.square_units:
        raise ValueError("Expected calibration in meters")
    model = YOLO(str(DEFAULT_WEIGHTS.with_name("yolo11n-seg.pt")))
    frames = []
    for row in recording_rows(args.recording, 0, 36, stereo.skew_ms):
        i = int(row["pair"])
        left, right = [cv2.imread(str(args.recording / f"{i:04}-{side}.jpg")) for side in "AB"]
        image = Image.fromarray(cv2.cvtColor(left, cv2.COLOR_BGR2RGB))
        objects, masks = detect(model, image, confidence=.25, return_masks=True)
        accepted = [(obj, mask) for obj, mask in zip(objects, masks or []) if obj["confidence"] >= .4]
        depth = raft_depth.compute(stereo, left, right)
        candidate, _, _ = plane_candidates(left, [obj for obj, _ in accepted], None, i)
        plane = fit_support_plane(depth, stereo.camera_a, candidate)
        frames.append((depth, plane, [(obj["bbox"], mask) for obj, mask in accepted]))
    if len(frames) != 37:
        raise ValueError("Expected 37 synchronized frames")

    for frame in frames:
        measure(frame, stereo.camera_a, True)
        measure(frame, stereo.camera_a, False)
    rows = []
    for repeat in range(5):
        for i, frame in enumerate(frames):
            for enabled in ((False, True) if (repeat+i) % 2 == 0 else (True, False)):
                start = perf_counter_ns()
                distances = measure(frame, stereo.camera_a, enabled)
                elapsed_ms = (perf_counter_ns() - start) / 1e6
                rows.append(dict(repeat=repeat, frame=i, mode="mask" if enabled else "bbox",
                                 objects=len(frame[2]), plane_valid=int(frame[1].validated),
                                 mask_distances=sum(s is not None and s["source"] == "mask" for s in distances),
                                 elapsed_ms=elapsed_ms))
    with args.output.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=rows[0], lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    for mode in ("bbox", "mask"):
        for subset in ("all", "validated"):
            times = [r["elapsed_ms"] for r in rows if r["mode"] == mode and (subset == "all" or r["plane_valid"])]
            print(mode, subset, len(times), "median/P95 ms", np.percentile(times, [50, 95]))


if __name__ == "__main__":
    main()
