import json
import math
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image

from geometry import deproject, ground_axes
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
        for z, level in [(6, 'clear'), (5.3, 'hold'), (5., 'caution'), (3., 'urgent')]:
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


    def test_dynamic_road_geometry_and_curb_drop_keep_visual_risk(self):
        road, pavement = crossing()
        stereo = self.stereo
        yy, xx = np.indices(road.shape)
        rays = deproject(np.stack((xx, yy), axis=-1), 1., stereo.camera_a).reshape(H, W, 3)
        normal = np.array([.12, -.93, -.34])
        normal /= np.linalg.norm(normal)
        axes = ground_axes(normal)
        plane = SimpleNamespace(validated=True, normal=normal, d=1.15, holdout_p90_m=.01)
        along_normal = rays @ normal
        for drop in (0., .12):
            height = np.where(road, -drop, 0.)
            depth = np.divide(height - plane.d, along_normal,
                              out=np.full(road.shape, np.nan), where=along_normal < -.05)
            measured = self.estimator.locate(road, pavement, depth, axes=axes, plane=plane)
            ordinary = self.estimator.locate(road, pavement, depth, axes=axes)
            static = self.estimator.locate(road, pavement, depth)
            self.assertEqual(measured["level"], ordinary["level"])
            self.assertEqual(measured["distance_m"], ordinary["distance_m"])
            self.assertGreater(abs(measured["distance_m"] - static["distance_m"]), .1)
            self.assertAlmostEqual(measured["curb_drop_m"], drop, places=3)
            self.assertEqual(measured["curb_confidence"], "supported" if drop else "uncertain")
