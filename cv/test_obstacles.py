import unittest
from types import SimpleNamespace

import numpy as np

from geometry import ground_axes
from obstacles import PlaneObstacles, is_obstacle_candidate, unclassified_obstacles
from test_plane_ransac import scene


class ObstacleCandidateTests(unittest.TestCase):
    def test_object_in_lower_center_is_candidate(self):
        self.assertTrue(is_obstacle_candidate([.4, .25, .6, .8]))

    def test_wide_object_can_block_path_with_center_outside_it(self):
        self.assertTrue(is_obstacle_candidate([.1, .2, .5, .8]))

    def test_side_high_and_grazing_objects_are_excluded(self):
        for box in ([.05, .25, .25, .9], [.40, .10, .60, .59], [.10, .25, .36, .9]):
            with self.subTest(box=box):
                self.assertFalse(is_obstacle_candidate(box))


class ObstacleSemanticTests(unittest.TestCase):
    def test_votes_on_component_pixels_and_preserves_geometry(self):
        depth, camera, _, _, normal, projection = scene(noisy=False)
        plane = SimpleNamespace(validated=True, normal=normal, d=.55, holdout_p90_m=.01)
        pole = np.s_[514:544, 206:218]
        wall = np.s_[556:568, 245:274]
        for region in (pole, wall):
            depth[region] = (.18 - .55) / projection[region]
        # Subtract the center of each pole row from the geometry, leaving one connected shape.
        background = np.ones(depth.shape, dtype=bool)
        background[516:542, 209:215] = False
        semantics = np.full(depth.shape, 255, dtype=np.uint8)
        semantics[516:542, 209:215] = 3
        semantics[519:521, 206:209] = 5
        semantics[522:524, 206:209] = 5
        semantics[556:564, 245:274] = 3
        semantics[564:568, 245:274] = 4
        args = depth, camera, plane, background, PlaneObstacles(), ground_axes(normal)
        legacy = unclassified_obstacles(*args)
        self.assertEqual(len(legacy), 2)
        actual = unclassified_obstacles(*args, semantic_map=semantics)
        labels = {obj.pop("semantic_label"): obj.pop("semantic_confidence") for obj in actual}
        self.assertEqual(labels, {"pole": 1.0, "wall": .67})
        self.assertEqual(actual, legacy)

        semantics[556:558, 245:274] = 6
        actual = unclassified_obstacles(*args, semantic_map=semantics)
        self.assertIn(dict(legacy[0], semantic_label="wall", semantic_confidence=.50), actual)

        # Sparse pole evidence and a three-way mix on the wall must both abstain.
        semantics[519, 206] = 255
        semantics[556:560, 245:274] = 6
        actual = unclassified_obstacles(*args, semantic_map=semantics)
        self.assertEqual(actual, [dict(obj, semantic_label="unknown") for obj in legacy])
        semantics.fill(255)
        self.assertEqual(unclassified_obstacles(*args, semantic_map=semantics), actual)
        with self.assertRaises(ValueError):
            unclassified_obstacles(*args, semantic_map=semantics.T)
