import json
import math
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge
from stereo_depth import StereoDepth
from test_stereo_depth import configuration

CONFIG = json.loads(DEFAULT_ROAD_CONFIG.read_text())
H, W = 192, 320


def crossing(row=137):
    road = np.zeros((H, W), bool)
    road[:row] = True
    return road, ~road


class RoadTests(unittest.TestCase):
    def setUp(self):
        self.stereo = StereoDepth(configuration())
        self.estimator = RoadEdge(CONFIG, self.stereo, None)

    def test_approach_and_no_depth(self):
        road, sidewalk = crossing()
        for z, level in [(5., 'clear'), (4.2, 'clear'), (4., 'hold'), (3.51, 'hold'),
                         (3.5, 'caution'), (3., 'caution'), (2., 'caution')]:
            result = self.estimator.locate(road, sidewalk, np.full((H, W), z))
            self.assertEqual((result['level'], result['distance_m']), (level, z))
        for z in (None, np.full((H, W), np.nan)):
            observation = self.estimator.locate(road, sidewalk, z)
            self.assertEqual(observation['level'], 'visual')
            self.assertNotIn('distance_m', observation)

    def test_parallel_and_outside_corridor_and_opposite_approach(self):
        road = np.indices((H, W))[1] > W*.7
        depth = np.full((H, W), 3.)
        self.assertEqual(self.estimator.locate(road, ~road, depth)['level'], 'unseen')
        # A visible transition on the far right is outside the metric corridor.
        road[:135, 245:] = True
        road[135:] = False
        self.assertEqual(self.estimator.locate(road, ~road, depth)['level'], 'unseen')
        road, sidewalk = crossing()
        self.assertEqual(self.estimator.locate(sidewalk, road, depth)['level'], 'unseen')

    def test_pitch_and_sparse_or_inconsistent_depth(self):
        road, sidewalk = crossing(139)
        config = {**CONFIG, 'pitch_down_deg': 20}
        down = RoadEdge(config, self.stereo, None)
        result = down.locate(road, sidewalk, np.full((H, W), 4.))
        y = result['point'][1]*H
        theta = math.radians(20)
        expected = 4*(math.cos(theta) - (y-96)/240*math.sin(theta))
        self.assertAlmostEqual(result['distance_m'], expected, places=2)
        sparse = np.full((H, W), np.nan)
        sparse[138, 160] = 1.0
        self.assertEqual(down.locate(road, sidewalk, sparse)['level'], 'visual')
        noisy = np.where(np.indices((H, W))[0]%2, 2., 6.)
        self.assertEqual(down.locate(road, sidewalk, noisy)['level'], 'visual')

    def test_no_calibration_only_reports_visual_cue(self):
        model = RoadEdge(CONFIG, None, None)
        self.assertEqual(model.locate(*crossing(), None)['level'], 'visual')
        far = crossing(45)
        self.assertEqual(model.locate(*far, None)['level'], 'unseen')

    @unittest.skipUnless((DEFAULT_ROAD_CONFIG.parent / CONFIG['model']).is_file(), 'optional road weights')
    def test_real_road_and_sidewalk_segmentation(self):
        from ultralytics.utils import ASSETS
        with Image.open(Path(ASSETS) / 'bus.jpg') as sample:
            sample.thumbnail((640, 640))
            model = RoadEdge.load(DEFAULT_ROAD_CONFIG, None)
            road, pavement = model.segment(sample, model.confidence)
        self.assertGreater(road.sum(), 1000)
        self.assertGreater(pavement.sum(), 1000)
        self.assertFalse((road & pavement).any())
