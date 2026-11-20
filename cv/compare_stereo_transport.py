"""Measure stereo pairing and geometry on one live rig with a fixed calibration."""
import argparse
import json
from pathlib import Path
import time

import cv2
import numpy as np
import requests

from stereo_depth import StereoDepth


def read(session, url, route, **options):
    response = session.get(url + route, timeout=3, **options)
    response.raise_for_status()
    return response


def capture(url, mode, limit, interval, skew_limit):
    rows = []
    images = []
    with requests.Session() as session:
        sources = read(session, url, "/sources").json()["sources"]
        cameras = [{entry["source_id"] for entry in sources if entry["camera_id"] == side}
                   for side in "AB"]
        rigs = cameras[0] & cameras[1]
        if len(rigs) != 1:
            raise ValueError("Open one live dashboard with both cameras connected in the selected mode.")
        params = {"source_id": rigs.pop(), "camera_id": "A"}
        deadline = time.monotonic() + max(20, limit * interval * 3)
        etag = None
        while len(rows) < limit and time.monotonic() < deadline:
            left = read(session, url, "/frame", params=params,
                        headers={"If-None-Match": etag} if etag else {})
            if left.status_code == 200:
                transport = left.headers["X-CV-Transport"]
                if transport != ("webrtc" if mode == "webrtc" else "image") or left.headers["Content-Type"] != "image/jpeg":
                    raise ValueError(f"Camera A must stream in {mode} mode.")
                etag = left.headers["ETag"]
                right = read(session, url, "/stereo-partner",
                             params={**params, "frame_id": etag.strip('"'), "max_skew_ms": skew_limit})
                row = {"timed": "X-CV-Sample-Ms" in left.headers, "matched": right.status_code == 200}
                if row["matched"]:
                    if right.headers["Content-Type"] != "image/jpeg":
                        raise ValueError(f"Camera B must stream in {mode} mode.")
                    row["skew"] = int(right.headers["X-Partner-Skew-Ms"])
                    row["bound"] = int(right.headers["X-Partner-Skew-Bound-Ms"])
                    images.append((left.content, right.content))
                rows.append(row)
            time.sleep(interval)
    return rows, images


def inspect_geometry(stereo, images):
    coverage = []
    errors = []
    boards = 0
    wrong_size = 0
    sizes = set()
    for pair in images:
        decoded = [cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_GRAYSCALE)
                   for image in pair]
        sizes.add(tuple(tuple(image.shape[::-1]) if image is not None else () for image in decoded))
        if any(image is None or image.shape != stereo.size[::-1] for image in decoded):
            wrong_size += 1
            continue
        depth = stereo.compute(*decoded)
        coverage.append(float(np.isfinite(depth).mean()))
        rectified = [cv2.remap(image, *maps, cv2.INTER_LINEAR) for image, maps in zip(decoded, stereo.maps)]
        corners = [cv2.findChessboardCornersSB(image, (9, 6)) for image in rectified]
        if all(found for found, _ in corners):
            boards += 1
            left, right = (points.reshape(-1, 2) for _, points in corners)
            candidates = (np.abs(left[:, 1] - right[:, 1]), np.abs(left[:, 1] - right[::-1, 1]))
            errors.extend(min(candidates, key=np.median))
    return {
        "image_size_mismatch_pairs": wrong_size,
        "observed_image_sizes_ab": sorted(sizes),
        "checkerboard_pairs": boards,
        "rectified_vertical_error_median_px": float(np.median(errors)) if errors else None,
        "rectified_vertical_error_p95_px": float(np.percentile(errors, 95)) if errors else None,
        "depth_valid_fraction_median": float(np.median(coverage)) if coverage else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8786")
    parser.add_argument("--mode", choices=("jpeg", "webrtc"), required=True)
    parser.add_argument("--stereo-config", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=60)
    parser.add_argument("--interval", type=float, default=.22)
    args = parser.parse_args()
    if not 1 <= args.samples <= 120 or not .05 <= args.interval <= 2:
        parser.error("Use 1–120 samples and a sampling interval from .05 to 2 seconds.")
    try:
        stereo = StereoDepth.load(args.stereo_config)
        if stereo is None:
            raise ValueError("Use the enabled calibration for this exact physical rig, lens and dimensions.")
        cv2.setNumThreads(1)
        rows, images = capture(args.server.rstrip("/") + "/api/cv", args.mode, args.samples,
                               args.interval, min(stereo.skew_ms, 65))
        if not rows:
            raise ValueError("No frames from Camera A.")
        paired = [row for row in rows if row["matched"]]
        result = {
            "mode": args.mode,
            "resolution": stereo.size,
            "sampled_a_frames": len(rows),
            "timed_a_frames": sum(row["timed"] for row in rows),
            "paired_frames": len(paired),
            "pair_rate": len(paired) / len(rows),
            "skew_bound_limit_ms": min(stereo.skew_ms, 65),
            "skew_bound_p95_ms": float(np.percentile([row["bound"] for row in paired], 95)) if paired else None,
            **inspect_geometry(stereo, images),
        }
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, cv2.error, requests.RequestException) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
