import unittest

import numpy as np

from door_alerts import observe_door


class DoorObservationTests(unittest.TestCase):
    def setUp(self):
        self.mask = np.zeros((128, 128), dtype=bool)
        self.mask[14:110, 44:84] = True
        self.depth = np.full((256, 256), 9., dtype=np.float32)
        self.depth[30:218, 90:166] = 1.

    def test_samples_the_mask_interior_in_camera_coordinates(self):
        result = observe_door(self.mask, self.depth)
        self.assertEqual(result, {"bbox": [44/128, 14/128, 84/128, 110/128], "distance_m": 1.0})

    def test_noisy_or_missing_depth_retains_only_the_visual_observation(self):
        self.depth[30:124, 90:166] = 2.
        for depth in (None, self.depth, np.full_like(self.depth, np.nan)):
            with self.subTest(depth="absent" if depth is None else "unreliable"):
                self.assertNotIn("distance_m", observe_door(self.mask, depth))

    def test_ignores_doors_off_to_the_side_and_tiny_fragments(self):
        self.mask.fill(False)
        self.mask[14:110, 90:115] = True
        self.mask[70:78, 58:63] = True
        self.assertIsNone(observe_door(self.mask, self.depth))
