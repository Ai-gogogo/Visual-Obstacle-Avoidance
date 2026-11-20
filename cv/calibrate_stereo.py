"""Capture checkerboard pairs from the paired phones and fit stereo_config.json."""

import argparse
import json
import os
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import requests

from stereo_depth import DEFAULT_CONFIG, StereoDepth


def capture(args):
    api = args.server.rstrip("/") + "/api/cv"
    with requests.Session() as http:
        def get(endpoint, **params):
            response = http.get(api + endpoint, params=params, timeout=4)
            response.raise_for_status()
            return response

        sources = get("/sources").json()["sources"]
        a = {s["source_id"] for s in sources if s["camera_id"] == "A"}
        b = {s["source_id"] for s in sources if s["camera_id"] == "B"}
        rigs = a & b
        if len(rigs) != 1:
            raise ValueError("Open one live dashboard with both phones paired and uploading")
        params = {"source_id": rigs.pop(), "camera_id": "A"}
        args.pairs.mkdir(parents=True, exist_ok=True)
        print("Hold the board still for each pair. Move or tilt the board between pairs.")
        while True:
            if input("Enter to save a pair, q to finish: ").strip().lower() == "q":
                break
            for _ in range(20):
                left = get("/frame", **params)
                if left.status_code == 200:
                    right = get("/stereo-partner", **params, frame_id=left.headers["ETag"].strip('"'),
                                max_skew_ms=65)
                    if right.status_code == 200:
                        folder = args.pairs / left.headers["ETag"].strip('"')
                        if not folder.exists():
                            folder.mkdir()
                            (folder / "A.jpg").write_bytes(left.content)
                            (folder / "B.jpg").write_bytes(right.content)
                            print("Saved", folder)
                            break
                time.sleep(.15)
            else:
                print("No new time-matched pair. Check both live phones and retry.")


def solve(args):
    cols, rows = args.corners
    if min(cols, rows) < 3 or not np.isfinite(args.square_mm) or args.square_mm <= 0:
        raise ValueError("Provide inner corner counts and a positive square edge in millimeters")
    target = np.zeros((rows*cols, 3), np.float32)
    target[:, :2] = np.mgrid[:cols, :rows].T.reshape(-1, 2) * (args.square_mm / 1000)
    a_points, b_points = [], []
    size = None
    for folder in sorted(args.pairs.iterdir()):
        if not folder.is_dir():
            continue
        points = []
        for side in "AB":
            image = cv2.imread(str(folder / f"{side}.jpg"), cv2.IMREAD_GRAYSCALE)
            if image is None:
                break
            if size is None:
                size = image.shape[::-1]
            if image.shape[::-1] != size:
                raise ValueError(f"Image dimensions changed in {folder}")
            found, corners = cv2.findChessboardCornersSB(image, (cols, rows))
            if not found:
                break
            points.append(corners)
        if len(points) < 2:
            print("Skipping incomplete or undetected board in", folder)
            continue
        left, right = points
        # A horizontal rig sees the ordering along the board in the same direction.
        if np.dot((left[-1]-left[0]).ravel(), (right[-1]-right[0]).ravel()) < 0:
            right = right[::-1].copy()
        a_points.append(left)
        b_points.append(right)
    if len(a_points) < 8:
        raise ValueError(f"Found {len(a_points)} usable pairs; collect at least 8 varied views")
    targets = [target] * len(a_points)
    _, ka, da, _, _ = cv2.calibrateCamera(targets, a_points, size, None, None)
    _, kb, db, _, _ = cv2.calibrateCamera(targets, b_points, size, None, None)
    rms, _, _, _, _, rotation, translation, _, _ = cv2.stereoCalibrate(
        targets, a_points, b_points, ka, da, kb, db, size, flags=cv2.CALIB_FIX_INTRINSIC)
    baseline = float(np.linalg.norm(translation))

    def camera(k, d):
        return dict(fx=k[0, 0], fy=k[1, 1], cx=k[0, 2], cy=k[1, 2], distortion=d.ravel().tolist())

    config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
    config.update(enabled=True, image_size_px=list(size), baseline_m=baseline,
                  camera_A=camera(ka, da), camera_B=camera(kb, db), rotation_A_to_B=rotation.tolist(),
                  translation_direction_A_to_B=(translation.ravel() / baseline).tolist())
    StereoDepth(config)  # Check geometry before replacing the requested file.
    content = json.dumps(config, indent=2, allow_nan=False) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False, encoding="utf-8") as output:
        output.write(content)
    os.replace(output.name, args.output)
    print(f"{len(targets)} pairs, stereo reprojection RMS {rms:.3f} px, baseline {baseline:.4f} m. Saved {args.output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    collect = subs.add_parser("capture")
    collect.add_argument("--server", default="http://127.0.0.1:8765")
    collect.add_argument("--pairs", type=Path, required=True)
    fit = subs.add_parser("solve")
    fit.add_argument("--pairs", type=Path, required=True)
    fit.add_argument("--corners", type=int, nargs=2, default=[9, 6], metavar=("COLS", "ROWS"))
    fit.add_argument("--square-mm", type=float, required=True)
    fit.add_argument("--output", type=Path, required=True, help="Replace this configuration after a successful fit")
    args = parser.parse_args()
    try:
        (capture if args.action == "capture" else solve)(args)
    except (OSError, ValueError, cv2.error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
