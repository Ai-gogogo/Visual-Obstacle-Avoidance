"""Time the S1 detection API on the first 37 Camera A frames of a recording."""

import argparse
import csv
import json
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
from PIL import Image, ImageOps
import torch
from ultralytics import YOLO

from detect_image import DEFAULT_WEIGHTS, detect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not torch.backends.mps.is_available():
        parser.error("Apple MPS is required")

    torch.set_num_threads(4)
    cv2.setNumThreads(1)
    device = torch.device("mps")
    models = [YOLO(str(DEFAULT_WEIGHTS)), YOLO(str(DEFAULT_WEIGHTS.with_name("yolo11n-seg.pt")))]
    frames = []
    for index in range(37):
        with Image.open(args.recording / f"{index:04}-A.jpg") as image:
            frames.append(ImageOps.exif_transpose(image).convert("RGB"))

    def run(model, frame):
        return detect(model, frame, device=device, confidence=.25, return_masks=model.task == "segment")

    for model in models:
        for frame in frames[:10]:
            run(model, frame)
        assert model.predictor.device.type == "mps"
    rows = []
    for repeat in range(3):
        for index, frame in enumerate(frames):
            # Reverse the order on alternate pairs to balance warm-cache and clock effects.
            for model in (models if (repeat + index) % 2 == 0 else reversed(models)):
                torch.mps.synchronize()
                start = perf_counter()
                result = run(model, frame)
                torch.mps.synchronize()
                elapsed = 1000 * (perf_counter() - start)
                if model.task == "segment":
                    objects, masks = result
                    assert len(objects) == len(masks or [])
                    assert all(m.dtype == bool and m.shape == frame.size[::-1] for m in masks or [])
                else:
                    objects = result
                rows.append(dict(repeat=repeat, frame=index, model=model.task,
                                 objects=len(objects), elapsed_ms=elapsed))

    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / "per-frame.csv").open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=rows[0], lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    summary = {}
    for model in models:
        times = [r["elapsed_ms"] for r in rows if r["model"] == model.task]
        summary[model.task] = dict(zip(("median_ms", "p95_ms"), np.percentile(times, [50, 95])))
    summary["increase"] = {k: v - summary["detect"][k] for k, v in summary["segment"].items()}
    report = json.dumps(summary, indent=2)
    (args.output / "summary.json").write_text(report + "\n")
    print(report)


if __name__ == "__main__":
    main()
