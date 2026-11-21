"""Tests for the optional Camera A semantic segmentation."""
from pathlib import Path
import unittest

import numpy as np
from PIL import Image

from scene_segmentation import DEFAULT_SCENE_MODEL, SceneSampler, SceneSegmenter


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
        for path, wanted in [(root/'web/public/demo-lab.webp', (0, 3)),
                             (Path(ASSETS)/'bus.jpg', (6, 11))]:
            with Image.open(path) as image:
                labels = model.labels(image.convert("RGB"))
            for label in wanted:
                self.assertGreater(np.count_nonzero(labels == label), 100)
