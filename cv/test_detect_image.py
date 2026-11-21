import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image, ImageOps

from detect_image import annotate, detect, make_object

CV = Path(__file__).resolve().parent
WEIGHTS = CV / "models/yolo11n.pt"
SEG_WEIGHTS = CV / "models/yolo11n-seg.pt"


class DetectionContractTests(unittest.TestCase):
    def test_batched_mask_crop_matches_native_with_padding_holes_and_an_empty_instance(self):
        import torch
        from ultralytics.models.yolo.segment import SegmentationPredictor
        from mps_segmentation import MpsSegmentationPredictor

        # Portrait source letterboxed into a square. Two disjoint regions in the
        # first prototype expose shifts; the second instance has no positive pixels.
        source = np.zeros((71, 43, 3), np.uint8)
        network_input = torch.zeros(1, 3, 96, 96)
        proto = torch.full((2, 24, 24), -2.)
        proto[0, 4:8, 9:12] = 3
        proto[0, 13:18, 13:16] = 5
        pred = torch.tensor([[26.4, 12.1, 65.6, 74.9, .92, 0, 1, 0],
                             [0, 0, 96, 96, .82, 1, 0, 1]])
        args = dict(overrides={"retina_masks": True})
        results = []
        for cls in (SegmentationPredictor, MpsSegmentationPredictor):
            predictor = cls(**args)
            predictor.model = SimpleNamespace(names={0: "chair", 1: "table"})
            results.append(predictor.construct_result(pred.clone(), network_input, source, "test", proto))
        reference, batched = results
        self.assertEqual(len(reference.boxes), 1)
        np.testing.assert_array_equal(batched.boxes.data.numpy(), reference.boxes.data.numpy())
        np.testing.assert_array_equal(batched.masks.data.numpy(), reference.masks.data.numpy())

    def test_mask_morphology_moves_edges_by_requested_radius(self):
        from mask_utils import dilate_mask, erode_mask

        mask = np.zeros((21, 25), dtype=bool)
        mask[5:16, 7:18] = True
        for function, span in [(erode_mask, (9, 15)), (dilate_mask, (3, 21))]:
            with self.subTest(function=function.__name__):
                actual = function(mask)
                self.assertEqual(actual.dtype, bool)
                self.assertEqual(actual.shape, mask.shape)
                self.assertEqual(np.flatnonzero(actual[10]).tolist(), list(range(span[0], span[1] + 1)))
                np.testing.assert_array_equal(function(mask, 0), mask)
                self.assertEqual(np.count_nonzero(mask), 121)

    def test_positions_use_box_midpoint_and_half_open_thirds(self):
        # At width 300, midpoints 100 and 200 start center and right.
        for x, expected in [(99, "left"), (100, "center"), (199, "center"), (200, "right")]:
            with self.subTest(x=x):
                obj = make_object("chair", 0.75, [x - 30, 5, x + 30, 15], (300, 20))
                self.assertEqual(obj["position"], expected)

    def test_box_is_normalized_against_original_width_and_height(self):
        obj = make_object("chair", 0.75, [30, 10, 90, 80], (120, 100))
        self.assertEqual(obj, {"label": "chair", "position": "center", "confidence": 0.75,
                               "bbox": [0.25, 0.1, 0.75, 0.8]})

    def test_annotation_draws_box_at_json_coordinates(self):
        image = Image.new("RGB", (120, 100), "white")
        obj = make_object("chair", 0.75, [30, 10, 90, 80], image.size)
        marked = annotate(image, [obj])
        self.assertNotEqual(marked.getpixel((60, 80)), (255, 255, 255))
        self.assertEqual(marked.getpixel((60, 65)), (255, 255, 255))
        self.assertEqual(marked.getpixel((100, 85)), (255, 255, 255))


class RealModelTests(unittest.TestCase):
    def test_detection_weights_have_no_masks_and_preserve_objects(self):
        from ultralytics import YOLO
        from ultralytics.utils import ASSETS

        model = YOLO(str(WEIGHTS))
        with Image.open(ASSETS / "bus.jpg") as image:
            expected = detect(model, image)
            objects, masks = detect(model, image, return_masks=True)
        self.assertTrue(objects)
        self.assertEqual(objects, expected)
        self.assertIsNone(masks)

    @unittest.skipUnless(SEG_WEIGHTS.is_file(), "optional YOLO11n segmentation weights required")
    def test_instance_masks_follow_boxes_in_original_image_coordinates(self):
        from ultralytics import YOLO
        from ultralytics.utils import ASSETS

        model = YOLO(str(SEG_WEIGHTS))
        with Image.open(ASSETS / "bus.jpg") as image:
            width, height = image.size
            objects, masks = detect(model, image, return_masks=True)
        self.assertGreaterEqual(len(objects), 2)
        self.assertEqual(len(masks), len(objects))
        for obj, mask in zip(objects, masks):
            self.assertEqual(mask.dtype, bool)
            self.assertEqual(mask.shape, (height, width))
            y, x = np.nonzero(mask)
            self.assertGreater(x.size, 0)
            left, top, right, bottom = obj["bbox"]
            self.assertGreaterEqual(x.min(), left * width - 2)
            self.assertGreaterEqual(y.min(), top * height - 2)
            self.assertLessEqual(x.max(), right * width + 2)
            self.assertLessEqual(y.max(), bottom * height + 2)
        json.dumps({"objects": objects}, allow_nan=False)
        self.assertEqual(detect(model, Image.new("RGB", (320, 180)), return_masks=True), ([], None))

    def run_detector(self, image, output):
        subprocess.run([sys.executable, str(CV / "detect_image.py"), str(image),
                        "--weights", str(WEIGHTS), "--output", str(output)], check=True)
        with Image.open(output / "annotated.jpg") as annotated, Image.open(image) as original:
            self.assertEqual(annotated.size, ImageOps.exif_transpose(original).size)
        return json.loads((output / "detections.json").read_text())["objects"]

    def test_known_objects_on_bundled_bus_photo(self):
        from ultralytics.utils import ASSETS

        with tempfile.TemporaryDirectory() as directory:
            objects = self.run_detector(ASSETS / "bus.jpg", Path(directory) / "bus")
            observed = {(obj["label"], obj["position"]) for obj in objects}
            self.assertTrue({("bus", "center"), ("person", "left"), ("person", "right")} <= observed)
            for obj in objects:
                x1, y1, x2, y2 = obj["bbox"]
                self.assertTrue(0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1)
                self.assertIn(obj["relative_depth"], {"near", "far", "unknown"})
                self.assertTrue(0 <= obj["confidence"] <= 1)

    def test_blank_image_returns_empty_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "blank.jpg"
            exif = Image.Exif()
            exif[274] = 6  # Portrait JPEG stored sideways.
            Image.new("RGB", (320, 180), "white").save(image, exif=exif)
            self.assertEqual(self.run_detector(image, Path(directory) / "blank"), [])


if __name__ == "__main__":
    unittest.main()
