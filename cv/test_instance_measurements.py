"""Known geometry for two legs with a visible support surface between them."""
import unittest
from types import SimpleNamespace

import numpy as np

from plane_ransac import object_height_m
from mask_utils import InstanceMask
from stereo_depth import object_depth, object_depth_stats


class InstanceMeasurementTests(unittest.TestCase):
    def setUp(self):
        self.box = [.1, .1, .9, .9]
        self.depth = np.full((100, 100), 3., np.float32)
        self.mask = np.zeros(self.depth.shape, bool)
        self.mask[10:90, 10:20] = self.mask[10:90, 80:90] = True
        # Looking straight down at a support surface 3 m away.
        self.camera = (np.array([[80., 0, 50], [0, 80., 50], [0, 0, 1.]]), None)
        self.plane = SimpleNamespace(validated=True, normal=np.array([0, 0, -1.]), d=3., holdout_p90_m=0.)

    def height(self, mask=None):
        return object_height_m(self.depth, self.camera, self.plane, self.box, mask=mask)

    def test_legs_have_distinct_nearest_surface_and_height(self):
        self.depth[self.mask] = .3  # Contaminated two-pixel rim.
        for x in (12, 82):
            self.depth[12:88, x:x+6] = 2.
            self.depth[12:27, x:x+6] = 1.8  # 15/76 of the interior.
        self.assertEqual(object_depth(self.depth, self.box), 3.)
        self.assertEqual(self.height()["median_m"], 0.)
        self.assertEqual(object_depth_stats(self.depth, self.box, mask=self.mask),
                         {"median_m": 2., "nearest_m": 1.8, "source": "mask"})
        self.assertEqual(object_depth(self.depth, self.box, mask=self.mask), 2.)
        heights = self.height(self.mask)
        self.assertAlmostEqual(heights["median_m"], 1.)
        self.assertAlmostEqual(heights["p90_m"], 1.2, places=6)
        self.assertEqual(heights["above_fraction"], 1.)

    def test_thin_mask_then_bbox_at_24_valid_pixels(self):
        self.mask[:] = False
        self.mask[10, 10:34] = True
        self.depth[self.mask] = 2.
        self.assertEqual(object_depth_stats(self.depth, self.box, mask=self.mask)["source"], "mask")
        self.assertEqual(self.height(self.mask)["median_m"], 1.)
        self.depth[10, 10] = np.nan
        self.assertEqual(object_depth_stats(self.depth, self.box, mask=self.mask),
                         {"median_m": 3., "nearest_m": 3., "source": "bbox"})
        self.assertEqual(self.height(self.mask)["median_m"], 0.)

    def test_low_coverage_and_inconsistent_mask_fall_back_to_box(self):
        self.depth[self.mask] = np.nan
        self.depth[12:42, 12:18] = 1.  # >=24 samples but <40% coverage.
        self.assertEqual(object_depth_stats(self.depth, self.box, mask=self.mask)["source"], "bbox")
        self.depth[10:90, 10:20] = 1.
        self.depth[10:90, 80:90] = 2.
        self.assertEqual(object_depth_stats(self.depth, self.box, mask=self.mask)["source"], "bbox")
        self.depth[30:70, 30:70] = np.nan
        self.assertIsNone(object_depth_stats(self.depth, self.box, mask=self.mask))

    def test_tilted_plane_uses_original_pixel_coordinates_and_current_depth(self):
        from test_plane_ransac import scene

        depth, camera, _, _, normal, projection = scene(noisy=False)
        mask = np.zeros_like(depth, dtype=bool)
        mask[510:590, 65:78] = mask[510:590, 180:193] = True
        box = [65/480, 510/640, 193/480, 590/640]
        plane = SimpleNamespace(validated=True, normal=normal, d=.55, holdout_p90_m=0.)
        instance = InstanceMask(mask)
        for height in (.12, .22):
            current = depth.copy()
            current[mask] = (height - .55) / projection[mask]
            object_depth_stats(current, box, mask=instance)
            stats = object_height_m(current, camera, plane, box, mask=instance)
            self.assertAlmostEqual(stats["median_m"], height, places=6)
            self.assertAlmostEqual(stats["p90_m"], height, places=6)
            self.assertEqual(stats["above_fraction"], 1.)
        plane.validated = False
        self.assertIsNone(object_height_m(current, camera, plane, box, mask=instance))
