import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageOps

from detect_image import annotate, make_object

CV = Path(__file__).resolve().parent
WEIGHTS = CV / "models/yolo11n.pt"


class DetectionContractTests(unittest.TestCase):
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
