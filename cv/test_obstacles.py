import unittest

from obstacles import is_obstacle_candidate


class ObstacleCandidateTests(unittest.TestCase):
    def test_object_in_lower_center_is_candidate(self):
        self.assertTrue(is_obstacle_candidate([.4, .25, .6, .8]))

    def test_wide_object_can_block_path_with_center_outside_it(self):
        self.assertTrue(is_obstacle_candidate([.1, .2, .5, .8]))

    def test_side_high_and_grazing_objects_are_excluded(self):
        for box in ([.05, .25, .25, .9], [.40, .10, .60, .59], [.10, .25, .36, .9]):
            with self.subTest(box=box):
                self.assertFalse(is_obstacle_candidate(box))
