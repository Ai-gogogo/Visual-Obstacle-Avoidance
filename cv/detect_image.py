"""Detect objects in one image and save the boxes as JSON and a labeled JPEG."""

import argparse
import json
import tempfile
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


def detect(model, image):
    result = model.predict(image, device="cpu", imgsz=640, conf=0.4, iou=0.7,
                           max_det=40, verbose=False)[0]
    boxes = result.boxes
    return [
        make_object(result.names[int(cls)], score, box, image.size)
        for cls, score, box in zip(boxes.cls.tolist(), boxes.conf.tolist(), boxes.xyxy.tolist())
    ]


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
        caption = f'{obj["label"]} | {obj["position"]} | {obj["confidence"]:.2f}'
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
