"""Compare raw stereo depth on the same timestamped Camera A/B recording."""
import argparse
from collections import Counter, defaultdict
import csv
from dataclasses import replace
from itertools import count, repeat
import json
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
from PIL import Image

from detect_image import DEFAULT_WEIGHTS, detect
from mask_utils import InstanceMask
from obstacles import PlaneObstacles
from path_intrusion import background_mask, support_background_mask
from plane_ransac import PlaneConfig, fit_support_plane, height_above_plane, object_height_m
import raft_depth
from road_edge import DEFAULT_ROAD_CONFIG
from stereo_depth import StereoDepth, object_depth_stats
from tracking import FrameTracker

ROOT = Path(__file__).resolve().parents[1]
ALGORITHMS = ("StereoSGBM", "RAFT-Stereo")
DEFAULT_SEG_WEIGHTS = DEFAULT_WEIGHTS.with_name("yolo11n-seg.pt")


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


def segmentation_frame(depth, stereo, objects, pixels, config):
    """Measure one set of detections on the shared, unfiltered Camera A depth."""
    start = perf_counter()
    instances = None if pixels is None else [InstanceMask(mask) if mask is not None else None for mask in pixels]
    background = support_background_mask(depth.shape, objects, masks=instances).astype(bool)
    foreground_ms = (perf_counter() - start) * 1000
    support = np.arange(depth.shape[0])[:, None] >= .45 * depth.shape[0]
    candidate = background & support
    start = perf_counter()
    plane = fit_support_plane(depth, stereo.camera_a, candidate, config=config)
    ransac_ms = (perf_counter() - start) * 1000
    start = perf_counter()
    measurements = []
    masks = repeat(None) if instances is None else instances
    for obj, instance in zip(objects, masks):
        distance = object_depth_stats(depth, obj["bbox"], mask=instance)
        height = object_height_m(depth, stereo.camera_a, plane, obj["bbox"], mask=instance)
        measurements.append({
            "label": obj["label"], "track_id": obj["track_id"], "has_instance_mask": instance is not None,
            "depth_m": distance["median_m"] if distance is not None else None,
            "nearest_depth_m": distance["nearest_m"] if distance is not None else None,
            "depth_source": distance["source"] if distance is not None else None,
            "height_m": height["median_m"] if height is not None else None,
        })
    measurement_ms = (perf_counter() - start) * 1000
    valid = np.isfinite(depth) & (depth > 0)
    result = dict(validated=plane.validated, reason=plane.reason,
                  eligible_depth_pixels=int(np.count_nonzero(valid & candidate)),
                  train_points=plane.train_points, train_inliers=plane.inliers, grid_cells=plane.grid_cells,
                  holdout_points=plane.holdout_points, holdout_p90_m=plane.holdout_p90_m,
                  foreground_ms=foreground_ms, ransac_ms=ransac_ms, measurement_ms=measurement_ms,
                  postprocess_ms=foreground_ms + measurement_ms)
    if instances is not None:
        # Control for the changed detector: keep its boxes fixed and change only the background cutout.
        start = perf_counter()
        same_boxes = support_background_mask(depth.shape, objects).astype(bool)
        result["same_boxes_foreground_ms"] = (perf_counter() - start) * 1000
        result["same_boxes_depth_pixel_gain"] = result["eligible_depth_pixels"] - int(
            np.count_nonzero(valid & same_boxes & support))
    return result, measurements, plane, background, candidate


def segmentation_summary(rows, measurements):
    heights = defaultdict(list)
    for obj in measurements:
        if obj["height_m"] is not None:
            heights[obj["track_id"]].append(obj["height_m"])
    tracks = {key: {"height_count": len(values), "std_m": float(np.std(values))}
              for key, values in sorted(heights.items()) if len(values) >= 2}
    residuals = [row["holdout_p90_m"] for row in rows if row["holdout_p90_m"] is not None]
    passed = sum(row["validated"] for row in rows)
    depth_count = sum(obj["depth_m"] is not None for obj in measurements)
    height_count = sum(obj["height_m"] is not None for obj in measurements)
    count_objects = len(measurements)
    result = dict(passed=passed, frames=len(rows), plane_pass_rate=passed / len(rows),
                  reasons=dict(Counter(row["reason"] for row in rows)),
                  holdout_frames=len(residuals), holdout_p90_median_m=float(np.median(residuals)) if residuals else None,
                  holdout_p90_p95_m=float(np.percentile(residuals, 95)) if residuals else None,
                  detections=count_objects, depth_count=depth_count, height_count=height_count,
                  depth_rate=depth_count / count_objects if count_objects else None,
                  height_rate=height_count / count_objects if count_objects else None,
                  mask_depth_count=sum(obj["depth_source"] == "mask" for obj in measurements),
                  height_tracks=tracks, height_track_std_median_m=(
                      float(np.median([track["std_m"] for track in tracks.values()])) if tracks else None))
    for key in ("eligible_depth_pixels", "train_points", "train_inliers", "grid_cells",
                "detector_ms", "foreground_ms", "measurement_ms", "ransac_ms", "postprocess_ms",
                "pipeline_ms", "same_boxes_foreground_ms", "same_boxes_depth_pixel_gain"):
        samples = [row[key] for row in rows if key in row]
        if samples:
            result[key] = {"mean": float(np.mean(samples)), "p95": float(np.percentile(samples, 95))}
    return result


def segmentation_overlay(image, depth, stereo, plane, background, candidate, label, pair, config):
    canvas = image.copy()
    canvas[~background] = .55 * canvas[~background] + .45 * np.array([40, 40, 255])
    if np.isfinite(plane.d):
        residual = np.abs(height_above_plane(depth, stereo.camera_a, replace(plane, validated=True)))
        x = np.arange(depth.shape[1])
        holdout = (x >= .44 * len(x)) & (x < .56 * len(x))
        for selection, color in (
            (candidate & ~holdout & (residual <= config.inlier_tol_m), (30, 205, 50)),
            (candidate & holdout & (residual <= config.holdout_p90_max_m), (0, 222, 250)),
        ):
            canvas[selection] = .35 * canvas[selection] + .65 * np.array(color)
    cv2.rectangle(canvas, (0, 0), (canvas.shape[1], 52), (18, 18, 18), -1)
    p90 = "n/a" if plane.holdout_p90_m is None else f"{1000 * plane.holdout_p90_m:.1f} mm"
    for y, text in ((19, f"{pair:04d}  {label}  {plane.reason}"),
                    (40, f"Inliers {plane.inliers} | Grid {plane.grid_cells} | Holdout P90 {p90}")):
        cv2.putText(canvas, text, (6, y), cv2.FONT_HERSHEY_SIMPLEX, .47, (255,)*3, 1, cv2.LINE_AA)
    return canvas


def run_segmentation(args, stereo, calibration, selected):
    from ultralytics import YOLO

    if args.roi_json is not None:
        raise ValueError("Segmentation comparison uses the live automatic support region")
    weights = {"bbox": args.weights, "mask": args.seg_weights}
    models = {}
    for label, checkpoint in weights.items():
        if not checkpoint.is_file():
            raise ValueError(f"Missing local weights: {checkpoint}")
        models[label] = YOLO(str(checkpoint))
    if models["bbox"].task != "detect" or models["mask"].task != "segment":
        raise ValueError("Comparison requires detection baseline and segmentation experiment checkpoints")
    config = PlaneObstacles.load(DEFAULT_ROAD_CONFIG, force=True).fit
    trackers = {label: FrameTracker(label, "A", count(1)) for label in models}
    raft_depth._load_model()
    out = ROOT / ".visionassist" / "seg-eval" / args.run_id
    (out / "overlay").mkdir(parents=True, exist_ok=False)
    (out / "calibration.json").write_bytes(calibration.read_bytes())
    results, measurements = [], []
    for index, row in enumerate(selected):
        pair = int(row["pair"])
        images = [cv2.imread(str(args.recording / (row.get(f"{side.lower()}_file")
                               or f"{pair:04d}-{side}.jpg"))) for side in "AB"]
        if any(image is None or image.shape[:2][::-1] != stereo.size for image in images):
            raise ValueError(f"Pair {pair} has a missing image or mismatched calibration size")
        left = Image.fromarray(cv2.cvtColor(images[0], cv2.COLOR_BGR2RGB))
        if index == 0:
            for model in models.values():
                detect(model, left, device=args.device, return_masks=True)
        start = perf_counter()
        depth = raft_depth.compute(stereo, *images)
        depth_ms = (perf_counter() - start) * 1000
        depth.setflags(write=False)
        tiles = {}
        # Alternate order so each model sees both first and second use of the shared frame.
        for label in (("bbox", "mask") if index % 2 == 0 else ("mask", "bbox")):
            start = perf_counter()
            objects, pixels = detect(models[label], left, device=args.device, return_masks=True)
            detector_ms = (perf_counter() - start) * 1000
            trackers[label].update(objects, round(float(row["elapsed_s"]) * 1000))
            result, objects_measured, plane, background, candidate = segmentation_frame(
                depth, stereo, objects, pixels, config)
            results.append(dict(pair=pair, pipeline=label, elapsed_s=float(row["elapsed_s"]),
                                skew_bound_ms=float(row["skew_bound_ms"]), depth_ms=depth_ms,
                                detections=len(objects), detector_ms=detector_ms,
                                pipeline_ms=detector_ms + result["postprocess_ms"] + result["ransac_ms"],
                                **result))
            measurements.extend(dict(pair=pair, pipeline=label, **obj) for obj in objects_measured)
            tiles[label] = segmentation_overlay(images[0], depth, stereo, plane, background, candidate,
                                                "YOLO bbox" if label == "bbox" else "YOLO Seg mask", pair, config)
        path = out / "overlay" / f"{pair:04d}-bbox-vs-mask.jpg"
        if not cv2.imwrite(str(path), np.hstack((tiles["bbox"], tiles["mask"]))):
            raise OSError(f"Cannot write {path}")
        print(f"Processed pair {pair:04d}", flush=True)
    for name, records in (("per-frame", results), ("per-object", measurements)):
        with (out / f"{name}.csv").open("w", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=list(dict.fromkeys(key for row in records for key in row)))
            writer.writeheader()
            writer.writerows(records)
    summary = dict(recording=str(args.recording), calibration=str(calibration), depth="raw RAFT-Stereo",
                   device=args.device, cpu_threads=args.cpu_threads, weights={k: str(v) for k, v in weights.items()},
                   first_pair=int(selected[0]["pair"]), last_pair=int(selected[-1]["pair"]),
                   max_skew_bound_ms=max(float(row["skew_bound_ms"]) for row in selected),
                   pipelines={label: segmentation_summary(
                       [row for row in results if row["pipeline"] == label],
                       [obj for obj in measurements if obj["pipeline"] == label]) for label in models})
    (out / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
    print(out)


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
    if args.segmentation_comparison:
        return run_segmentation(args, stereo, calibration, selected)
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
    parser.add_argument("--segmentation-comparison", action="store_true",
                        help="Compare YOLO bbox vs YOLO instance masks on the same raw RAFT depth")
    parser.add_argument("--seg-weights", type=Path, default=DEFAULT_SEG_WEIGHTS)
    parser.add_argument("--device", default="cpu", help="YOLO device for the segmentation comparison")
    args = parser.parse_args()
    if Path(args.run_id).name != args.run_id or args.run_id in {".", ".."}:
        parser.error("--run-id must be a single directory name")
    run(args)


if __name__ == "__main__":
    main()
