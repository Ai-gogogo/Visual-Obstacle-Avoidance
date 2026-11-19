"""Shared spatial HSV descriptors for personal-item matching."""

def unit(vector, version):
    import numpy as np

    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    magnitude = np.linalg.norm(vector)
    if not magnitude or not np.isfinite(magnitude):
        return None
    return {"version": version, "vector": (vector / magnitude).tolist()}


def item_features(image, boxes):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    features = []
    for x1, y1, x2, y2 in boxes:
        cropped = image[round(y1 * height):round(y2 * height), round(x1 * width):round(x2 * width)]
        if not cropped.size or min(cropped.shape[:2]) < 24:
            features.append(None)
            continue
        hsv = cv2.cvtColor(cv2.resize(cropped, (48, 48)), cv2.COLOR_BGR2HSV)
        cells = [hsv, hsv[:24, :24], hsv[:24, 24:], hsv[24:, :24], hsv[24:, 24:]]
        histograms = [
            np.sqrt(cv2.calcHist([cell], [0, 1, 2], None, [12, 3, 3],
                                [0, 180, 0, 256, 0, 256]).reshape(-1) / (cell.size / 3))
            for cell in cells
        ]
        features.append(unit(np.concatenate(histograms), "spatial-hsv-v1"))
    return features
