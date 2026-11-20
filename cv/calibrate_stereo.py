"""Fit stereo calibration from recorded video or an existing set of paired images."""

import argparse
import json
import os
import tempfile
from pathlib import Path

import cv2
import numpy as np

from box_target import CORNERS, FACES, object_points, read_layout
from inspect_checkerboard import inspect_pair
from stereo_depth import DEFAULT_CONFIG, StereoDepth, camera_parameters


def input_pairs(args):
    if args.video:
        stream = cv2.VideoCapture(str(args.video))
        if not stream.isOpened():
            raise ValueError(f"Cannot open stereo video {args.video}")
        index = 0
        last_sample_ms = -float("inf")
        previous_ms = -1.0
        try:
            while stream.grab():
                index += 1
                ms = stream.get(cv2.CAP_PROP_POS_MSEC)
                has_timestamp = np.isfinite(ms) and ms > previous_ms
                previous_ms = ms
                if has_timestamp:
                    if ms - last_sample_ms < 300:
                        continue
                    last_sample_ms = ms
                elif (index - 1) % 4:
                    continue
                ok, frame = stream.retrieve()
                if not ok or frame.shape[1] % 2:
                    raise ValueError(f"Invalid side-by-side video at frame {index}")
                yield str(index), np.hsplit(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 2)
        finally:
            stream.release()
        return
    for folder in sorted(args.pairs.iterdir()):
        if folder.is_dir() and not folder.name.startswith("."):
            images = [cv2.imread(str(folder / f"{side}.jpg"), cv2.IMREAD_GRAYSCALE) for side in "AB"]
            if all(image is not None for image in images):
                yield folder.name, images


def observations(args, mode, pattern):
    views = []
    size = None
    for name, images in input_pairs(args):
        if size is None:
            size = images[0].shape[::-1]
        if any(image.shape[::-1] != size for image in images):
            raise ValueError(f"Image dimensions changed in {name}")
        a, b = inspect_pair(images, mode, pattern)
        if not a["corners"] or not b["corners"] or (mode == "three" and len(a["faces"]) < 2):
            continue
        left, right = (np.array(v["corners"], dtype=np.float32) for v in (a, b))
        if mode == "single":
            if np.dot(left[-1]-left[0], right[-1]-right[0]) < 0:
                right = right[::-1].copy()
            # Choose a consistent orientation for pose de-duplication in videos.
            if tuple(left[0]) > tuple(left[-1]):
                left, right = left[::-1].copy(), right[::-1].copy()
        ids = np.array(a.get("ids", range(len(left))), dtype=np.int32)
        if args.video and any(similar_view(ids, left, right, view, max(size)*.024) for view in views):
            continue
        views.append((name, ids, left, right))
    return size, views


def similar_view(ids, left, right, previous, threshold):
    _, prior_ids, a, b = previous
    common, i, j = np.intersect1d(ids, prior_ids, return_indices=True)
    if len(common) < .7 * max(len(ids), len(prior_ids)):
        return False
    return all(np.mean(np.sum((new[i]-old[j])**2, axis=1)) < threshold**2
               for new, old in ((left, a), (right, b)))


def solve(args):
    cols, rows = args.corners
    mode = args.mode
    if mode == "single":
        if min(cols, rows) < 3 or args.square_mm is None or not np.isfinite(args.square_mm) or args.square_mm <= 0:
            raise ValueError("Provide inner corner counts and a positive --square-mm")
        target = np.zeros((rows*cols, 3), np.float32)
        target[:, :2] = np.mgrid[:cols, :rows].T.reshape(-1, 2) * (args.square_mm / 1000)
    else:
        if not args.layout:
            raise ValueError("Provide --layout with measured positions of the three grids")
        layout = read_layout(args.layout)
    size, views = observations(args, mode, (cols, rows))
    if len(views) < 8:
        raise ValueError(f"Found {len(views)} usable pairs; collect at least 8 varied views")
    a_points = [v[2] for v in views]
    b_points = [v[3] for v in views]
    if mode == "three":
        if len(np.unique(np.concatenate([v[1] for v in views]) // CORNERS)) != len(FACES):
            raise ValueError("Collect views of all three faces across the recording")
        targets = [object_points(v[1], layout) for v in views]
        # OpenCV requires initial intrinsics for non-planar targets. Initialize
        # from the individual planar faces, then jointly refine on rigid box poses.
        planar, left, right = [], [], []
        for (_, ids, a, b), xyz in zip(views, targets):
            for face in np.unique(ids // CORNERS):
                mask = ids // CORNERS == face
                plane = xyz[mask].copy()
                if face == 1:
                    plane[:, 0] = plane[:, 2]
                if face == 2:
                    plane[:, 1] = plane[:, 2]
                plane[:, 2] = 0
                planar.append(plane)
                left.append(a[mask])
                right.append(b[mask])
        intrinsic_seeds = [cv2.initCameraMatrix2D(planar, side, size, 0) for side in (left, right)]
        flags = cv2.CALIB_USE_INTRINSIC_GUESS
    else:
        targets = [target] * len(views)
        intrinsic_seeds = [None, None]
        flags = 0
    _, ka, da, _, _ = cv2.calibrateCamera(targets, a_points, size, intrinsic_seeds[0], None, flags=flags)
    _, kb, db, _, _ = cv2.calibrateCamera(targets, b_points, size, intrinsic_seeds[1], None, flags=flags)
    rms, _, _, _, _, rotation, translation, _, _ = cv2.stereoCalibrate(
        targets, a_points, b_points, ka, da, kb, db, size, flags=cv2.CALIB_FIX_INTRINSIC)
    baseline = float(np.linalg.norm(translation))

    def camera(k, d):
        return dict(fx=k[0, 0], fy=k[1, 1], cx=k[0, 2], cy=k[1, 2], distortion=d.ravel().tolist())

    config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
    config.update(units="meters", calibration_mode=mode, enabled=True, image_size_px=list(size), baseline_m=baseline,
                  camera_A=camera(ka, da), camera_B=camera(kb, db), rotation_A_to_B=rotation.tolist(),
                  translation_direction_A_to_B=(translation.ravel() / baseline).tolist())
    StereoDepth(config)  # Check geometry before replacing the requested file.
    content = json.dumps(config, indent=2, allow_nan=False) + "\n"
    if args.output is None:
        prefix = args.video.with_suffix("") if args.video else args.pairs
        args.output = prefix.parent / f"{prefix.name}-{mode}-config.json"
    with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False, encoding="utf-8") as output:
        output.write(content)
    os.replace(output.name, args.output)
    print(f"{len(targets)} pairs, stereo reprojection RMS {rms:.3f} px, baseline {baseline:.4f} m. Saved {args.output}")


def compare(args):
    size, views = observations(args, "single", (9, 6))
    if not views:
        raise ValueError("No common checkerboard detected in the independent verification video")
    for path in args.configs:
        config = json.loads(path.read_text())
        if list(size) != config["image_size_px"]:
            raise ValueError(f"{path}: verification video dimensions differ from calibration")
        ka, da = camera_parameters(config["camera_A"])
        kb, db = camera_parameters(config["camera_B"])
        rot = np.array(config["rotation_A_to_B"])
        trans = np.array(config["translation_direction_A_to_B"]) * config["baseline_m"]
        ra, rb, pa, pb, *_ = cv2.stereoRectify(ka, da, kb, db, size, rot, trans,
                                               flags=cv2.CALIB_ZERO_DISPARITY, alpha=0)
        errors = []
        for _, _, a, b in views:
            u = cv2.undistortPoints(a, ka, da, R=ra, P=pa).reshape(-1, 2)
            v = cv2.undistortPoints(b, kb, db, R=rb, P=pb).reshape(-1, 2)
            errors.extend(abs(u[:, 1] - v[:, 1]))
        median, p95 = np.percentile(errors, (50, 95))
        print(f"{path}: {len(views)} common poses, rectified vertical error P50 {median:.3f}, P95 {p95:.3f} px")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    fit = subs.add_parser("solve")
    source = fit.add_mutually_exclusive_group(required=True)
    source.add_argument("--pairs", type=Path)
    source.add_argument("--video", type=Path, help="Dashboard side-by-side WebM")
    fit.add_argument("--mode", choices=["single", "three"], default="single")
    fit.add_argument("--layout", type=Path, help="Measured three-face geometry JSON")
    fit.add_argument("--corners", type=int, nargs=2, default=[9, 6], metavar=("COLS", "ROWS"))
    fit.add_argument("--square-mm", type=float)
    fit.add_argument("--output", type=Path, help="Default: a mode-specific config next to the input")
    check = subs.add_parser("compare", help="Evaluate both configs on a separate plain-board recording")
    check.add_argument("--video", required=True, type=Path)
    check.add_argument("--configs", required=True, type=Path, nargs=2)
    args = parser.parse_args()
    try:
        {"solve": solve, "compare": compare}[args.action](args)
    except (OSError, ValueError, cv2.error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
