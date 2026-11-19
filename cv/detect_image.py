"""Detect objects in one image and save the boxes as JSON and a labeled JPEG."""

import argparse
import json
import tempfile
from itertools import combinations
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

DEFAULT_WEIGHTS = Path(__file__).resolve().parent / "models/yolo11n.pt"


def make_object(label, confidence, xyxy, image_size):
    width, height = image_size
    x1, y1, x2, y2 = xyxy
    center_x = (x1 + x2) / 2
    if center_x < width / 3:
        position = "left"
    elif center_x < 2 * width / 3:
        position = "center"
    else:
        position = "right"
    return {
        "label": label,
        "position": position,
        "confidence": confidence,
        "bbox": [x1 / width, y1 / height, x2 / width, y2 / height],
    }


# The bottom of an unobstructed box approximates contact with a common level floor.
GROUND_CLASSES = {"person", "chair", "bench", "couch", "bed", "dining table",
                  "bicycle", "motorcycle", "car", "bus", "truck", "train", "toilet"}
MIN_FOOT_SEPARATION = 0.12
END_GROUP_MARGIN = 0.04


def covers_point(box, x, y):
    left, top, right, bottom = box
    return left <= x <= right and top <= y <= bottom


def assign_relative_depth(objects):
    candidates = []
    for obj in objects:
        obj["relative_depth"] = "unknown"
        x1, y1, x2, foot = obj["bbox"]
        if (obj["label"] not in GROUND_CLASSES or obj["confidence"] < .5 or
                min(x1, y1, 1 - x2, 1 - foot) <= .01):
            continue
        center = (x1 + x2) / 2
        if any(other is not obj and covers_point(other["bbox"], center, foot) for other in objects):
            continue
        candidates.append((foot, obj))

    if len(candidates) < 2:
        return
    feet = [foot for foot, _ in candidates]
    highest, lowest = min(feet), max(feet)
    if lowest - highest < MIN_FOOT_SEPARATION:
        return
    # Contradictory evidence from a same-class pair questions the shared-floor assumption.
    for (back_y, back), (front_y, front) in combinations(sorted(candidates, key=lambda c: c[0]), 2):
        if front_y - back_y < MIN_FOOT_SEPARATION or back["label"] != front["label"]:
            continue
        back_height = back_y - back["bbox"][1]
        front_height = front_y - front["bbox"][1]
        if back_height > 1.25 * front_height:
            return
    for foot, obj in candidates:
        if lowest - foot <= END_GROUP_MARGIN:
            obj["relative_depth"] = "near"
        elif foot - highest <= END_GROUP_MARGIN:
            obj["relative_depth"] = "far"


def detect(model, image):
    result = model.predict(image, device="cpu", imgsz=640, conf=0.4, iou=0.7,
                           max_det=40, verbose=False)[0]
    boxes = result.boxes
    objects = [
        make_object(result.names[int(cls)], score, box, image.size)
        for cls, score, box in zip(boxes.cls.tolist(), boxes.conf.tolist(), boxes.xyxy.tolist())
    ]
    assign_relative_depth(objects)
    return objects


def annotate(image, objects):
    canvas = image.copy()
    draw = ImageDraw.Draw(canvas)
    width, height = image.size
    font = ImageFont.load_default(size=max(13, min(width, height) // 42))
    colors = {"left": "#116950", "center": "#1759a6", "right": "#9a4210"}
    for obj in objects:
        x1, y1, x2, y2 = obj["bbox"]
        box = (x1 * width, y1 * height, x2 * width, y2 * height)
        color = colors[obj["position"]]
        draw.rectangle(box, outline=color, width=max(2, min(width, height) // 220))
        caption = f'{obj["label"]} | {obj["position"]} | {obj["confidence"]:.2f} | {obj.get("relative_depth", "unknown")}'
        _, _, tw, th = draw.textbbox((0, 0), caption, font=font, anchor="lt")
        tx = max(0, min(box[0], width - tw - 8))
        ty = max(0, box[1] - th - 8)
        draw.rectangle((tx, ty, tx + tw + 8, ty + th + 8), fill=color)
        draw.text((tx + 4, ty + 4), caption, font=font, fill="white", anchor="lt")
    return canvas


def main():
    from ultralytics import YOLO

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--output", required=True, type=Path, help="New directory for this run")
    args = parser.parse_args()
    if not args.weights.is_file():
        parser.error(f"Missing local weights: {args.weights}. See cv/README.md for setup.")
    if args.output.exists():
        parser.error(f"Output already exists: {args.output}. Choose a new directory.")
    try:
        with Image.open(args.image) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
    except OSError as error:
        parser.error(f"Cannot read image: {error}")

    objects = detect(YOLO(str(args.weights), task="detect"), image)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent) as staging:
        result_dir = Path(staging) / "result"
        result_dir.mkdir()
        annotate(image, objects).save(result_dir / "annotated.jpg", quality=92)
        (result_dir / "detections.json").write_text(
            json.dumps({"objects": objects}, indent=2, allow_nan=False) + "\n", encoding="utf-8"
        )
        result_dir.rename(args.output)
    print(f"{len(objects)} objects. Results saved in {args.output}")


if __name__ == "__main__":
    main()
