import unittest

import numpy as np

from item_features import item_features


class ItemFeatureTests(unittest.TestCase):
    def test_same_frame_crops_distinguish_colors_and_skip_tiny_boxes(self):
        image = np.zeros((64, 128, 3), dtype=np.uint8)
        image[:, :64] = [0, 0, 255]
        image[:, 64:] = [255, 0, 0]
        boxes = [[0, 0, .5, 1], [.5, 0, 1, 1], [0, 0, .1, .1]]
        red, blue, tiny = item_features(image, boxes)

        self.assertIsNone(tiny)
        for feature in (red, blue):
            self.assertEqual(feature["version"], "spatial-hsv-v1")
            self.assertEqual(len(feature["vector"]), 540)
            self.assertAlmostEqual(np.linalg.norm(feature["vector"]), 1)
        self.assertLess(np.dot(red["vector"], blue["vector"]), .92)
