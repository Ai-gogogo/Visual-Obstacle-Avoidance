"""Replay the held-out epipolar check using corner coordinates alone."""
import json
from pathlib import Path

import cv2
import numpy as np

root = Path(__file__).resolve().parent
p = json.loads((root / "parameters.json").read_text())
ref = json.loads((root / "validation.json").read_text())
ka, da, kb, db, rotation, translation = (np.array(p[k]) for k in ("ka", "da", "kb", "db", "R", "T"))
ra, rb, pa, pb, *_ = cv2.stereoRectify(
    ka, da, kb, db, tuple(p["size"]), rotation, translation, flags=cv2.CALIB_ZERO_DISPARITY, alpha=0)
rows = np.loadtxt(root / "held-corners.csv", delimiter=",", skiprows=1)
errors = []
assert set(rows[:, 0]) == {frame for frame, _ in ref["held_p95"]}
assert not set(rows[:, 0]).intersection(ref["train"])
for frame, expected in ref["held_p95"]:
    corners = rows[rows[:, 0] == frame]
    assert len(corners) == 54
    left, right = [
        cv2.undistortPoints(corners[:, cols].astype(np.float32), k, d, R=r, P=proj).reshape(-1, 2)
        for cols, k, d, r, proj in ((slice(2, 4), ka, da, ra, pa), (slice(4, 6), kb, db, rb, pb))]
    dy = np.abs(left[:, 1] - right[:, 1])
    np.testing.assert_allclose(np.percentile(dy, 95), expected, atol=.002)
    errors.extend(dy)
percentiles = np.percentile(errors, [50, 95])
np.testing.assert_allclose(percentiles, ref["rect_median_p95"], atol=.002)
print(f"{len(errors)} held-out corners: median {percentiles[0]:.3f} px, P95 {percentiles[1]:.3f} px")
