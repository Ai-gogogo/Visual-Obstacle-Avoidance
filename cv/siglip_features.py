
"""SigLIP2 visual features for personal object identification."""

import argparse
from threading import Lock

import cv2
import numpy as np
import torch
from PIL import Image, ImageOps
from transformers import AutoModel, AutoProcessor


MODEL_ID = "google/siglip2-base-patch16-224"
FEATURE_VERSION = "siglip2-base-patch16-224-v1"


class SigLIPExtractor:
    def __init__(self, model_id=MODEL_ID, device=None):
        self.device = device or (
            "mps" if torch.backends.mps.is_available()
            else "cuda" if torch.cuda.is_available()
            else "cpu"
        )

        print(f"Loading {model_id} on {self.device}", flush=True)

        self.processor = AutoProcessor.from_pretrained(model_id)
        self.model = AutoModel.from_pretrained(model_id)
        self.model = self.model.to(self.device).eval()

        # Camera A and B share one model.
        self.lock = Lock()

    @torch.inference_mode()
    def _encode(self, images):
        if not images:
            return []

        inputs = self.processor(
            images=images,
            return_tensors="pt"
        ).to(self.device)

        with self.lock:
            output = self.model.get_image_features(**inputs)

        vectors = (
            output.pooler_output
            if hasattr(output, "pooler_output")
            else output
        )

        vectors = torch.nn.functional.normalize(
            vectors.float(), p=2, dim=-1
        )

        return vectors.cpu().numpy()

    def extract(self, image_path):
        """Extract one normalized vector from an image file."""
        with Image.open(image_path) as img:
            image = ImageOps.exif_transpose(img).convert("RGB")

        return self._encode([image])[0]

    def extract_boxes(self, image_bgr, boxes):
        """
        Extract features from normalized YOLO bounding boxes.

        image_bgr: OpenCV BGR image
        boxes: [[x1, y1, x2, y2], ...], coordinates in [0, 1]

        Returns one descriptor or None per box.
        """
        height, width = image_bgr.shape[:2]
        features = [None] * len(boxes)

        crops = []
        valid_indices = []

        for index, (x1, y1, x2, y2) in enumerate(boxes):
            left = max(0, min(width, round(x1 * width)))
            top = max(0, min(height, round(y1 * height)))
            right = max(0, min(width, round(x2 * width)))
            bottom = max(0, min(height, round(y2 * height)))

            if right - left < 24 or bottom - top < 24:
                continue

            crop = image_bgr[top:bottom, left:right]

            if crop.size == 0:
                continue

            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            crops.append(Image.fromarray(rgb))
            valid_indices.append(index)

        if not crops:
            return features

        vectors = self._encode(crops)

        for index, vector in zip(valid_indices, vectors):
            if vector.shape != (768,):
                continue
            if not np.isfinite(vector).all():
                continue

            features[index] = {
                "version": FEATURE_VERSION,
                "vector": vector.astype(float).tolist()
            }

        return features


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--reference", required=True)
    args = parser.parse_args()

    encoder = SigLIPExtractor()
    query = encoder.extract(args.query)
    reference = encoder.extract(args.reference)

    similarity = float(np.dot(query, reference))

    print("Feature dimensions:", len(query))
    print("Cosine similarity:", round(similarity, 4))


if __name__ == "__main__":
    main()
