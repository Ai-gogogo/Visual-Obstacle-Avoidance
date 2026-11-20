"""Read two base64 JPEGs on stdin and locate the printed 9 x 6 inner corners."""
import base64
import json
import sys

import cv2
import numpy as np


def inspect(jpeg):
    image = cv2.imdecode(np.frombuffer(base64.b64decode(jpeg), np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Invalid JPEG")
    found, corners = cv2.findChessboardCornersSB(image, (9, 6))
    points = corners.reshape(-1, 2).round(1).tolist() if found else []
    return {"size": list(image.shape[::-1]), "corners": points}


if __name__ == "__main__":
    cv2.setNumThreads(1)
    print(json.dumps([inspect(image) for image in json.load(sys.stdin)]))
