"""Compare raw stereo depth on the same timestamped Camera A/B recording."""
import argparse
from collections import Counter
import csv
from dataclasses import replace
import json
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
from PIL import Image

from detect_image import DEFAULT_WEIGHTS, detect
from path_intrusion import background_mask
from plane_ransac import PlaneConfig, fit_support_plane, height_above_plane, object_height_m
import raft_depth
from stereo_depth import StereoDepth

ROOT = Path(__file__).resolve().parents[1]
ALGORITHMS = ("StereoSGBM", "RAFT-Stereo")


def recording_rows(directory, first, last, max_skew):
    with (directory / "timestamps.csv").open(newline="") as manifest:
        rows = [row for row in csv.DictReader(manifest)
                if int(row["pair"]) >= first and (last is None or int(row["pair"]) <= last)]
    ids = [int(row["pair"]) for row in rows]
    if not ids or ids != sorted(set(ids)):
        raise ValueError("The selected range must contain ordered, unique pairs")
    if any(not 0 <= float(row["skew_bound_ms"]) <= max_skew for row in rows):
        raise ValueError("A selected pair exceeds the calibrated synchronization limit")
    return rows


def masks(image, objects, roi, pair):
    h, w = image.shape[:2]
    if roi is None:
        candidate = np.broadcast_to(np.arange(h)[:, None] >= .45 * h, (h, w)).copy()
    else:
        candidate = np.zeros((h, w), np.uint8)
        cv2.fillPoly(candidate, [np.array(roi["candidate_polygon_px"], dtype=np.int32)], 1)
        candidate = candidate.astype(bool)

    target = max((obj for obj in objects if obj["label"] == "cup"),
                 key=lambda obj: obj["confidence"], default=None)
    box = None if target is None else target["bbox"]
    foreground = [obj for obj in objects if obj["label"] != "dining table"]
    if roi is not None and roi.get("cup_boxes_px"):
        # Interpolate the manually marked visible cup between image keyframes.
        keys = sorted((int(key), box) for key, box in roi["cup_boxes_px"].items())
        indices, boxes = zip(*keys)
        if indices[0] <= pair <= indices[-1]:
            pixels = [np.interp(pair, indices, values) for values in np.array(boxes).T]
            box = np.array(pixels) / [w, h, w, h]
            foreground.append({"bbox": box})
    candidate &= background_mask((h, w), foreground).astype(bool)
    x = np.arange(w)
    holdout = np.broadcast_to((x >= .44 * w) & (x < .56 * w), (h, w))
    return candidate, holdout, box


def center_slice(box, shape):
    h, w = shape
    left, top, right, bottom = np.clip(box, 0, 1) * [w, h, w, h]
    dx, dy = (right - left) / 4, (bottom - top) / 4
    return (slice(int(np.floor(top + dy)), int(np.ceil(bottom - dy))),
            slice(int(np.floor(left + dx)), int(np.ceil(right - dx))))


def overlay(image, depth, stereo, plane, candidate, holdout, box, label, pair, config, path):
    canvas = image.copy()
    point_count = 0
    if box is not None:
        region = center_slice(box, depth.shape)
        point_count = int(np.count_nonzero(np.isfinite(depth[region]) & (depth[region] > 0)))
        cv2.rectangle(canvas, (region[1].start, region[0].start),
                      (region[1].stop - 1, region[0].stop - 1), (255, 230, 125), 1)
    if np.isfinite(plane.d):
        # A rejected fit is shown for diagnosis only. Heights are reported only
        # for a plane accepted by the original gates.
        heights = height_above_plane(depth, stereo.camera_a, replace(plane, validated=True))
        error = np.abs(heights)
        held = candidate & holdout & np.isfinite(error)
        masks_and_colors = [
            (candidate & ~holdout & (error <= config.inlier_tol_m), (30, 205, 50)),
            (held & (error <= config.holdout_p90_max_m), (0, 222, 250)),
            (held & (error > config.holdout_p90_max_m), (215, 50, 180)),
        ]
        if box is not None and plane.validated:
            above = np.zeros(depth.shape, dtype=bool)
            band = max(config.inlier_tol_m, plane.holdout_p90_m)
            above[region] = heights[region] > band
            masks_and_colors.append((above, (0, 140, 255)))
        for mask, color in masks_and_colors:
            canvas[mask] = .35 * canvas[mask] + .65 * np.array(color)
    cv2.rectangle(canvas, (0, 0), (canvas.shape[1], 58), (18, 18, 18), -1)
    residual = "P90 unavailable" if plane.holdout_p90_m is None else f"P90 {plane.holdout_p90_m*1000:.1f} mm"
    cv2.putText(canvas, f"{pair:04d}  {label}  {plane.reason}", (5, 20), 0, .47, (255,)*3, 1, cv2.LINE_AA)
    cv2.putText(canvas, f"{residual}   cup valid pixels: {point_count}", (5, 44), 0, .49, (255,)*3, 1, cv2.LINE_AA)
    if not cv2.imwrite(str(path), canvas):
        raise OSError(f"Cannot write {path}")
    return point_count


def summarize(rows):
    results = {}
    common = set.intersection(*({r["pair"] for r in rows if r["algorithm"] == label
                                and r["cup_median_m"] is not None} for label in ALGORITHMS))
    for label in ALGORITHMS:
        selected = [r for r in rows if r["algorithm"] == label]
        residuals = [r["holdout_p90_m"] for r in selected if r["holdout_p90_m"] is not None]
        heights = np.array([r["cup_median_m"] for r in selected if r["cup_median_m"] is not None])
        shared = np.array([r["cup_median_m"] for r in selected if r["pair"] in common])
        timings = [r["ransac_ms"] for r in selected]
        results[label] = {
            "passed": sum(r["validated"] for r in selected),
            "total": len(selected),
            "reasons": dict(Counter(r["reason"] for r in selected)),
            "holdout_frames": len(residuals),
            "holdout_p50_m": float(np.percentile(residuals, 50)) if residuals else None,
            "holdout_p90_m": float(np.percentile(residuals, 90)) if residuals else None,
            "cup_frames_with_depth": sum(r["cup_valid_pixels"] > 0 for r in selected),
            "cup_height_frames": len(heights),
            "cup_height_median_m": float(np.median(heights)) if len(heights) else None,
            "cup_height_std_m": float(heights.std()) if len(heights) >= 2 else None,
            "cup_shared_frames": len(shared),
            "cup_shared_height_std_m": float(shared.std()) if len(shared) >= 2 else None,
            "ransac_mean_ms": float(np.mean(timings)),
            "ransac_p95_ms": float(np.percentile(timings, 95)),
            "depth_mean_ms": float(np.mean([r["depth_ms"] for r in selected])),
        }
    return results


def run(args):
    import torch
    from ultralytics import YOLO

    torch.set_num_threads(args.cpu_threads)
    cv2.setNumThreads(1)
    calibration = args.calibration or args.recording / "calibration.json"
    stereo = StereoDepth.load(calibration)
    if stereo is None or stereo.square_units:
        raise ValueError("Evaluation requires enabled metric stereo calibration")
    selected = recording_rows(args.recording, args.first_pair, args.last_pair, stereo.skew_ms)
    roi = json.loads(args.roi_json.read_text()) if args.roi_json else None
    if roi is not None and roi.get("image_size_px") != list(stereo.size):
        raise ValueError("ROI and calibration image sizes differ")
    config = PlaneConfig()
    out = ROOT / ".visionassist" / "plane-eval" / args.run_id
    out.mkdir(parents=True, exist_ok=False)
    (out / "overlay").mkdir()
    if args.roi_json:
        (out / "roi.json").write_bytes(args.roi_json.read_bytes())
    (out / "calibration.json").write_bytes(calibration.read_bytes())
    model = YOLO(str(args.weights), task="detect")
    raft_depth._load_model()  # Load once before measuring depth inference.
    results = []
    for row in selected:
        pair = int(row["pair"])
        left, right = [cv2.imread(str(args.recording / (row.get(f"{side.lower()}_file")
                               or f"{pair:04d}-{side}.jpg"))) for side in "AB"]
        if any(im is None or im.shape[:2][::-1] != stereo.size for im in (left, right)):
            raise ValueError(f"Pair {pair} has a missing image or mismatched calibration size")
        objects = detect(model, Image.fromarray(cv2.cvtColor(left, cv2.COLOR_BGR2RGB)))
        candidate, holdout, box = masks(left, objects, roi, pair)
        for label in ALGORITHMS:
            start = perf_counter()
            if label == "StereoSGBM":
                depth = stereo.compute(cv2.cvtColor(left, cv2.COLOR_BGR2GRAY),
                                       cv2.cvtColor(right, cv2.COLOR_BGR2GRAY))
            else:
                depth = raft_depth.compute(stereo, left, right)
            depth_ms = 1000 * (perf_counter() - start)
            start = perf_counter()
            plane = fit_support_plane(depth, stereo.camera_a, candidate, holdout_mask=holdout, config=config)
            ransac_ms = 1000 * (perf_counter() - start)
            height = object_height_m(depth, stereo.camera_a, plane, box) if box is not None else None
            points = overlay(left, depth, stereo, plane, candidate, holdout, box, label, pair,
                             config, out / "overlay" / f"{pair:04d}-{label}.jpg")
            results.append(dict(pair=pair, elapsed_s=float(row["elapsed_s"]),
                                skew_bound_ms=float(row["skew_bound_ms"]), algorithm=label,
                                train_points=plane.train_points, inliers=plane.inliers,
                                inlier_ratio=plane.inlier_ratio, grid_cells=plane.grid_cells,
                                holdout_points=plane.holdout_points, holdout_p90_m=plane.holdout_p90_m,
                                validated=plane.validated, reason=plane.reason, cup_valid_pixels=points,
                                cup_median_m=height["median_m"] if height else None,
                                cup_above_fraction=height["above_fraction"] if height else None,
                                depth_ms=depth_ms, ransac_ms=ransac_ms))
        print(f"Processed pair {pair:04d}", flush=True)
    with (out / "per-frame.csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(results[0]))
        writer.writeheader()
        writer.writerows(results)
    summary = dict(recording=str(args.recording), calibration=str(calibration),
                   first_pair=int(selected[0]["pair"]), last_pair=int(selected[-1]["pair"]),
                   max_skew_bound_ms=max(float(row["skew_bound_ms"]) for row in selected),
                   predefined_roi=roi is not None, algorithms=summarize(results))
    (out / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
    print(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--calibration", type=Path)
    parser.add_argument("--roi-json", type=Path,
                        help="Camera A image_size_px, candidate_polygon_px and optional cup_boxes_px keyed by pair")
    parser.add_argument("--first-pair", type=int, default=0)
    parser.add_argument("--last-pair", type=int)
    parser.add_argument("--cpu-threads", type=int, default=4)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    args = parser.parse_args()
    if Path(args.run_id).name != args.run_id or args.run_id in {".", ".."}:
        parser.error("--run-id must be a single directory name")
    run(args)


if __name__ == "__main__":
    main()
