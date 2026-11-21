import json
import math
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge
from scene_segmentation import DEFAULT_SCENE_MODEL, SceneSampler, SceneSegmenter
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


class SceneSegmentationTests(unittest.TestCase):
    def test_busy_sampler_keeps_latest_frame_and_its_id(self):
        from threading import Event
        from unittest.mock import Mock, patch
        entered, release, finished = Event(), Event(), Event()
        processed = []

        def labels(image):
            processed.append(image.width)
            entered.set()
            if not release.wait(3):
                raise AssertionError("Inference did not resume")
            return np.zeros((128, 128), np.uint8)

        published = []
        def post(url, *, params, timeout, json):
            published.append((params["source_id"], json["frame_id"], json["width"]))
            if len(published) == 2:
                finished.set()
            return Mock(status_code=204)

        with patch("scene_segmentation.requests.Session") as session:
            session.return_value.__enter__.return_value.post.side_effect = post
            sampler = SceneSampler(Mock(labels=labels), "http://localhost/api/cv", 100)
            sampler.thread.start()
            try:
                sampler.offer("desk", "first", Image.new("RGB", (100, 64)))
                self.assertTrue(entered.wait(3))
                sampler.offer("desk", "second", Image.new("RGB", (120, 64)))
                sampler.offer("desk", "latest", Image.new("RGB", (160, 64)))
                release.set()
                self.assertTrue(finished.wait(3))
            finally:
                release.set()
                sampler.close()
        self.assertEqual(processed, [100, 160])
        self.assertEqual(published, [("desk", "first", 100), ("desk", "latest", 160)])

    def test_low_confidence_and_class_ids(self):
        from unittest.mock import Mock
        logits = np.zeros((150, 128, 128), dtype=np.float32)
        for x, label in enumerate((3, 6, 11, 15, 149)):
            logits[label, :, x] = 12
        model = SceneSegmenter.__new__(SceneSegmenter)
        model.logits = Mock(return_value=logits)
        labels = model.labels(None)
        np.testing.assert_array_equal(labels[0, :6], [3, 6, 11, 15, 149, 255])
        self.assertEqual(labels.dtype, np.uint8)

    @unittest.skipUnless(DEFAULT_SCENE_MODEL.is_file(), 'optional ADE20K weights')
    def test_real_indoor_and_street_labels(self):
        from ultralytics.utils import ASSETS
        model = SceneSegmenter(DEFAULT_SCENE_MODEL)
        root = Path(__file__).resolve().parents[1]
        for path, wanted in [(root/'web/demo-lab.webp', (0, 3)),
                             (Path(ASSETS)/'bus.jpg', (6, 11))]:
            with Image.open(path) as image:
                labels = model.labels(image.convert("RGB"))
            for label in wanted:
                self.assertGreater(np.count_nonzero(labels == label), 100)
