"""Synthetic Camera A geometry with known perpendicular heights."""
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from plane_ransac import PlaneConfig, fit_support_plane, height_above_plane, object_height_m, predict_plane


def scene(pitch=15, shape=(640, 480), noisy=True):
    h, w = shape
    camera = (
        np.array([[420., 0, w / 2], [0, 420., h / 2], [0, 0, 1]]),
        np.array([.07, -.025, .002, -.001, 0.]),
    )
    y, x = np.indices(shape)
    rays = cv2.undistortPoints(np.stack((x, y), -1).astype('f').reshape(-1, 1, 2),
                               *camera).reshape(h, w, 2)
    angle = np.deg2rad(pitch)
    normal = np.array([0., -np.cos(angle), -np.sin(angle)])
    projection = rays[..., 1] * normal[1] + normal[2]
    candidate = (y >= h * .72) & (projection < -.05)
    holdout = (x >= w * .44) & (x < w * .56)
    depth = np.full(shape, np.nan, dtype=np.float32)
    rng = np.random.default_rng(81)
    depth[candidate] = -.55 / projection[candidate]
    if noisy:
        depth[candidate] += rng.normal(0, .003, candidate.sum())
        training = np.flatnonzero(candidate & ~holdout)
        outliers = rng.choice(training, len(training) // 5, replace=False)
        depth.flat[outliers] -= .22 / -projection.flat[outliers]
    return depth, camera, candidate, holdout, normal, projection


class PlaneRansacTest(unittest.TestCase):
    def test_known_plane_with_outliers_and_object_height(self):
        for pitch in (-15, 15):
            with self.subTest(pitch=pitch):
                depth, camera, candidate, _, normal, projection = scene(pitch)
                object_region = np.s_[510:550, 55:110]
                candidate[object_region] = False
                depth[object_region] = (.12 - .55) / projection[object_region]
                plane = fit_support_plane(depth, camera, candidate)
                self.assertTrue(plane.validated, plane)
                self.assertLess(plane.normal[1], 0)
                self.assertLess(np.degrees(np.arccos(np.clip(plane.normal @ normal, -1, 1))), 1)
                self.assertLess(abs(plane.d - .55), .005)
                self.assertAlmostEqual(plane.pitch_deg, pitch, delta=1)
                self.assertAlmostEqual(plane.roll_deg, 0, delta=1)
                heights = height_above_plane(depth, camera, plane)
                self.assertTrue(np.isnan(heights[0, 0]))
                np.testing.assert_allclose(heights[object_region], .12, atol=.005)
                stats = object_height_m(depth, camera, plane, (55/480, 510/640, 110/480, 550/640))
                self.assertAlmostEqual(stats["median_m"], .12, delta=.005)
                self.assertAlmostEqual(stats["p90_m"], .12, delta=.005)
                self.assertEqual(stats["above_fraction"], 1.)

    def test_independent_holdout_rejects_step(self):
        depth, camera, candidate, holdout, _, projection = scene(noisy=False)
        baseline = fit_support_plane(depth, camera, candidate, holdout_mask=holdout)
        self.assertTrue(baseline.validated, baseline)
        step = holdout & candidate
        depth[step] += .07 / projection[step]
        plane = fit_support_plane(depth, camera, candidate, holdout_mask=holdout)
        self.assertFalse(plane.validated)
        self.assertEqual(plane.reason, "holdout_p90_exceeded")
        self.assertAlmostEqual(plane.holdout_p90_m, .07, delta=.001)
        self.assertEqual(plane.train_points, baseline.train_points)
        np.testing.assert_array_equal(plane.normal, baseline.normal)
        self.assertEqual(plane.d, baseline.d)
        self.assertTrue(np.isnan(height_above_plane(depth, camera, plane)).all())
        self.assertIsNone(object_height_m(depth, camera, plane, (0, 0, 1, 1)))

    def test_determinism_and_missing_depth(self):
        depth, camera, candidate, holdout, _, _ = scene()
        first = fit_support_plane(depth, camera, candidate)
        second = fit_support_plane(depth, camera, candidate, config=PlaneConfig())
        np.testing.assert_array_equal(first.normal, second.normal)
        self.assertEqual(first.d, second.d)
        self.assertEqual(first.holdout_p90_m, second.holdout_p90_m)
        for count in (0, 39):
            with self.subTest(count=count):
                sparse = np.full_like(depth, np.nan)
                sparse.flat[np.flatnonzero(candidate & ~holdout)[:count]] = 2.
                plane = fit_support_plane(sparse, camera, candidate, holdout_mask=holdout)
                self.assertFalse(plane.validated)
                self.assertEqual(plane.reason, "insufficient_points")

    def test_spatial_spread_and_missing_holdout(self):
        depth, camera, candidate, _, _, _ = scene(noisy=False)
        empty = np.zeros_like(candidate)
        plane = fit_support_plane(depth, camera, candidate, holdout_mask=empty)
        self.assertFalse(plane.validated)
        self.assertEqual(plane.reason, "insufficient_holdout_points")
        local = empty.copy()
        local[500:520, 60:96] = True
        holdout = empty.copy()
        holdout[500:520, 60:65] = True
        plane = fit_support_plane(depth, camera, local, holdout_mask=holdout)
        self.assertFalse(plane.validated)
        self.assertEqual(plane.reason, "poor_spatial_spread")


    def test_transformed_prior_skips_sampling_only_when_independently_valid(self):
        depth, camera, candidate, held, _, _ = scene(noisy=False)
        previous = fit_support_plane(depth, camera, candidate, holdout_mask=held)
        rotation = cv2.Rodrigues(np.radians([12., 0., -8.]))[0]
        translation = np.array([.03, .19, -.03])
        prior = predict_plane(previous, rotation, translation)
        point = -previous.d * previous.normal
        self.assertAlmostEqual((rotation @ point + translation) @ prior.normal + prior.d, 0., places=7)
        with patch("plane_ransac._initial_plane", side_effect=AssertionError("sampled a good prior")):
            estimate = fit_support_plane(depth, camera, candidate, holdout_mask=held, prior_plane=previous)
        self.assertTrue(estimate.validated)
        self.assertTrue(estimate.used_prior)
        # A coherent current plane must win when the transformed prior does not agree.
        estimate = fit_support_plane(depth, camera, candidate, holdout_mask=held, prior_plane=prior)
        self.assertTrue(estimate.validated)
        self.assertFalse(estimate.used_prior)
        depth[candidate & held] *= .7
        estimate = fit_support_plane(depth, camera, candidate, holdout_mask=held, prior_plane=previous)
        self.assertFalse(estimate.validated)
        self.assertFalse(estimate.used_prior)
        self.assertEqual(estimate.reason, "holdout_p90_exceeded")


if __name__ == "__main__":
    unittest.main()
