"""Estimate a support plane from raw metric depth in Camera A coordinates."""
from dataclasses import dataclass, replace
from functools import lru_cache
import math

import numpy as np

from geometry import deproject
from mask_utils import sample_instance


@dataclass(frozen=True)
class PlaneConfig:
    inlier_tol_m: float = .015
    holdout_p90_max_m: float = .025
    min_train_inliers: int = 40
    min_inlier_ratio: float = .50
    min_grid_cells: int = 6
    min_holdout_points: int = 15
    max_sample_points: int = 2500
    iterations: int = 900
    seed: int = 4521


@dataclass(frozen=True)
class PlaneEstimate:
    validated: bool
    normal: np.ndarray
    d: float
    pitch_deg: float
    roll_deg: float
    train_points: int
    inliers: int
    inlier_ratio: float
    grid_cells: int
    holdout_points: int
    holdout_p90_m: float | None
    reason: str
    used_prior: bool = False


@lru_cache(maxsize=4)
def _cached_rays(shape, intrinsics, distortion):
    y, x = np.indices(shape, dtype=np.float32)
    camera = (np.array(intrinsics).reshape(3, 3), np.array(distortion))
    return np.ascontiguousarray(deproject(np.stack((x, y), axis=-1), 1., camera).T,
                                dtype=np.float32)


def _rays(shape, camera):
    intrinsics, distortion = camera
    coefficients = () if distortion is None else tuple(np.ravel(distortion))
    return _cached_rays(shape, tuple(np.ravel(intrinsics)), coefficients)


def _residuals(points, normal, offset):
    return (points[:, 0] * normal[0] + points[:, 1] * normal[1]
            + points[:, 2] * normal[2] + offset)


def _initial_plane(sample, rng, config):
    triples = sample[rng.integers(len(sample), size=(config.iterations, 3))]
    normals = np.cross(triples[:, 1] - triples[:, 0], triples[:, 2] - triples[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    usable = lengths > 1e-8
    normals = normals[usable] / lengths[usable, None]
    offsets = -np.sum(normals * triples[usable, 0], axis=1)
    if not len(normals):
        return None

    # Multiplication evaluates all sampled hypotheses in one float32 matrix.
    errors = normals @ sample.T
    errors += offsets[:, None]
    np.abs(errors, out=errors)
    winner = np.argmax(np.count_nonzero(errors <= config.inlier_tol_m, axis=1))
    return normals[winner], offsets[winner]


def fit_support_plane(depth_m, camera_a, candidate_mask, *, holdout_mask=None,
                      prior_plane=None, config=None) -> PlaneEstimate:
    """Fit to valid candidate pixels outside the holdout, then check both sets.

    Camera A uses axial depth and the same (intrinsics, distortion) pair as
    deproject(). Both masks have the depth image's shape. By default the
    central 12% of image columns are reserved for independent validation.
    """
    config = config or PlaneConfig()
    depth = np.asarray(depth_m)
    h, w = depth.shape
    candidates = np.asarray(candidate_mask, dtype=bool)
    if candidates.shape != depth.shape:
        raise ValueError("candidate_mask must have the depth image's shape")
    if holdout_mask is None:
        x = np.arange(w)
        holdout_mask = np.broadcast_to((x >= .44 * w) & (x < .56 * w), depth.shape)
    holdout_mask = np.asarray(holdout_mask, dtype=bool)
    if holdout_mask.shape != depth.shape:
        raise ValueError("holdout_mask must have the depth image's shape")
    valid = candidates & np.isfinite(depth) & (depth > 0)
    train = np.flatnonzero(valid & ~holdout_mask)
    holdout = np.flatnonzero(valid & holdout_mask)
    def assess(normal, offset, failure=None, *, used_prior=False):
        inliers = grid_cells = 0
        ratio = 0.
        p90 = None
        if failure is None:
            inlier_pixels = train[np.abs(normal @ points64 + offset) <= config.inlier_tol_m]
            inliers = len(inlier_pixels)
            ratio = inliers / len(train)
            # Match the offline experiment's 60x50 pixel grid.
            inlier_image = np.zeros(depth.shape, dtype=bool)
            inlier_image.flat[inlier_pixels] = True
            row_bands = np.logical_or.reduceat(inlier_image, np.arange(0, h, 50), axis=0)
            cells = np.logical_or.reduceat(row_bands, np.arange(0, w, 60), axis=1)
            grid_cells = int(np.count_nonzero(cells))
            if len(holdout):
                p90 = float(np.percentile(np.abs(_residuals(held_points.T, normal, offset)), 90))

            if inliers < config.min_train_inliers:
                failure = "insufficient_inliers"
            elif ratio < config.min_inlier_ratio:
                failure = "low_inlier_ratio"
            elif grid_cells < config.min_grid_cells:
                failure = "poor_spatial_spread"
            elif len(holdout) < config.min_holdout_points:
                failure = "insufficient_holdout_points"
            elif p90 is None or p90 > config.holdout_p90_max_m:
                failure = "holdout_p90_exceeded"

        return PlaneEstimate(
            failure is None, normal, float(offset), *_angles(normal),
            len(train), inliers, ratio, grid_cells, len(holdout), p90,
            failure or "ok", used_prior,
        )

    if len(train) < max(3, config.min_train_inliers):
        return assess(np.array([0., -1., 0.]), np.nan, "insufficient_points")

    rays = _rays(depth.shape, camera_a)
    flat_depth = depth.ravel()
    points = np.stack([axis[train] for axis in rays])
    points *= flat_depth[train].astype(np.float32, copy=False)
    points64 = points.astype(np.float64)
    held_points = rays[:, holdout] * flat_depth[holdout]
    if (prior_plane is not None and prior_plane.validated and prior_plane.normal[1] < 0
            and np.isfinite(prior_plane.d) and np.isclose(np.linalg.norm(prior_plane.normal), 1)):
        if assess(prior_plane.normal, prior_plane.d).validated:
            estimate = assess(*_refine(points64, config.inlier_tol_m, prior_plane.normal, prior_plane.d), used_prior=True)
            if estimate.validated:
                return estimate

    rng = np.random.default_rng(config.seed)
    sample = points[:, rng.choice(len(train), min(len(train), config.max_sample_points),
                                  replace=False)].T
    initial = _initial_plane(sample, rng, config)
    if initial is None:
        return assess(np.array([0., -1., 0.]), np.nan, "degenerate_plane")
    return assess(*_refine(points64, config.inlier_tol_m, *initial))


def _angles(normal):
    return (math.degrees(math.atan2(-normal[2], math.hypot(*normal[:2]))),
            math.degrees(math.atan2(normal[0], -normal[1])))


def predict_plane(plane, rotation, translation):
    """Transform a previously accepted plane into current camera coordinates."""
    normal = rotation @ plane.normal
    offset = plane.d - normal @ translation
    if normal[1] >= 0 or not np.isfinite(normal).all() or not np.isfinite(offset):
        return None
    pitch, roll = _angles(normal)
    return replace(plane, normal=normal, d=float(offset), pitch_deg=pitch, roll_deg=roll)


def _refine(points, tolerance, normal, offset):
    weighted = np.empty_like(points)
    previous_inliers = None
    for iteration in range(3):
        is_inlier = np.abs(normal @ points + offset) <= tolerance
        if iteration == 2 and np.array_equal(is_inlier, previous_inliers):
            break
        previous_inliers = is_inlier
        count = np.count_nonzero(is_inlier)
        if count < 3:
            return normal, offset, "insufficient_inliers"
        np.multiply(points, is_inlier, out=weighted)
        mean = weighted.sum(axis=1) / count
        scatter = weighted @ weighted.T - count * np.outer(mean, mean)
        _, singular_values, axes = np.linalg.svd(scatter)
        if singular_values[1] <= 1e-12 * singular_values[0]:
            return normal, offset, "degenerate_plane"
        normal = axes[-1]
        offset = -mean @ normal
    if normal[1] == 0:
        return normal, offset, "degenerate_plane"
    if normal[1] > 0:
        normal, offset = -normal, -offset
    return normal, offset, None


def height_above_plane(depth_m, camera_a, plane) -> np.ndarray:
    """Return signed perpendicular heights, with NaN where unavailable."""
    depth = np.asarray(depth_m)
    heights = np.full(depth.shape, np.nan, dtype=np.float32)
    if plane.validated:
        rays = _rays(depth.shape, camera_a)
        valid = np.flatnonzero(np.isfinite(depth) & (depth > 0))
        heights.flat[valid] = _residuals((rays[:, valid] * depth.ravel()[valid]).T,
                                         plane.normal, plane.d)
    return heights


def object_height_m(depth_m, camera_a, plane, bbox, *, mask=None, error_band_m=None) -> dict | None:
    """Summarize perpendicular heights on the instance, falling back to the central box."""
    if not plane.validated:
        return None
    depth = np.asarray(depth_m)
    h, w = depth.shape
    box = np.asarray(bbox, dtype=float)
    if box.shape != (4,) or not np.isfinite(box).all():
        return None
    left, top, right, bottom = np.clip(box, 0, 1) * [w, h, w, h]
    if left >= right or top >= bottom:
        return None
    samples = sample_instance(depth, mask)
    if samples is not None:
        rays = _rays(depth.shape, camera_a)[:, samples.pixels]
        values = samples.values
    else:
        dx, dy = (right - left) / 4, (bottom - top) / 4
        rows = slice(math.floor(top + dy), math.ceil(bottom - dy))
        cols = slice(math.floor(left + dx), math.ceil(right - dx))
        region = depth[rows, cols]
        valid = np.isfinite(region) & (region > 0)
        if not valid.any():
            return None
        values = region[valid]
        rays = _rays(depth.shape, camera_a).reshape(3, h, w)[:, rows, cols][:, valid]
    heights = _residuals((rays * values).T, plane.normal, plane.d)
    if error_band_m is None:
        error_band_m = max(PlaneConfig.inlier_tol_m, plane.holdout_p90_m or 0.)
    median, p90 = np.percentile(heights, [50, 90])
    return {"median_m": float(median), "p90_m": float(p90),
            "above_fraction": float(np.mean(heights > error_band_m))}
