"""Read A/B JPEGs and report corners that identify the same printed target."""
import base64
import json
import sys

import cv2
import numpy as np

from box_target import CORNERS, FACES, detect, shared_faces


def inspect_pair(images, mode="single", pattern=(9, 6)):
    boards = [{"size": list(image.shape[::-1]), "corners": []} for image in images]
    if mode == "single":
        for image, view in zip(images, boards):
            found, corners = cv2.findChessboardCornersSB(image, pattern)
            if found:
                view["corners"] = corners.reshape(-1, 2).tolist()
        return boards
    if mode != "three":
        raise ValueError("Unknown target mode")
    detections = [detect(image) for image in images]
    ids = shared_faces(*detections)
    for points, view in zip(detections, boards):
        view["ids"] = ids.tolist()
        view["faces"] = [FACES[int(f)] for f in np.unique(ids // CORNERS)]
        view["corners"] = [points[i].tolist() for i in ids]
    return boards


def inspect_jpegs(pair, mode):
    images = [cv2.imdecode(np.frombuffer(base64.b64decode(jpeg), np.uint8), cv2.IMREAD_GRAYSCALE)
              for jpeg in pair]
    if any(image is None for image in images):
        raise ValueError("Invalid JPEG")
    return inspect_pair(images, mode)


if __name__ == "__main__":
    cv2.setNumThreads(1)
    payload = json.load(sys.stdin)
    mode = sys.argv[1] if len(sys.argv) > 1 else "single"
    if sys.argv[2:] == ["--batch"]:
        print(json.dumps([inspect_jpegs(pair, mode) for pair in payload]))
    else:
        print(json.dumps(inspect_jpegs(payload, mode)))
