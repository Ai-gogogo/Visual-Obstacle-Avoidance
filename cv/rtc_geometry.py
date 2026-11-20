"""Compare static scene landmarks in each calibrated USB view with the Wi-Fi view."""
import cv2
import numpy as np


def landmarks(gray):
    points, descriptors = cv2.SIFT_create(nfeatures=1200).detectAndCompute(gray, None)
    return np.float32([p.pt for p in points]).reshape(-1, 2), descriptors


def same_view(reference, gray):
    xy, desc = reference
    points, current = landmarks(gray)
    if desc is None or current is None or len(current) < 2:
        return False
    pairs = cv2.BFMatcher().knnMatch(desc, current, k=2)
    matches = [a for a, b in pairs if a.distance < .68 * b.distance]
    if len(matches) < 30:
        return False
    before = np.array([xy[m.queryIdx] for m in matches])
    after = np.array([points[m.trainIdx] for m in matches])
    error = np.linalg.norm(before - after, axis=1)
    aligned = before[error <= 1.5]
    if len(aligned) < 30 or np.median(error) > 1.5:
        return False
    height, width = gray.shape
    # Require agreement around the field, so one small stationary patch cannot pass.
    cells = (aligned / [width/3, height/3]).astype(int)
    return len(set(map(tuple, cells))) >= 7


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Extract landmarks from an A-left, B-right USB calibration recording")
    parser.add_argument("video")
    parser.add_argument("output")
    args = parser.parse_args()
    cap = cv2.VideoCapture(args.video)
    ok, frame = cap.read()
    cap.release()
    if not ok or frame.shape[:2] != (640, 960):
        parser.error("Expected a side-by-side pair of portrait 480 × 640 views")
    data = {}
    for side, gray in zip("AB", np.hsplit(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 2)):
        xy, desc = landmarks(gray)
        if not same_view((xy,desc),gray):
            parser.error("Not enough distributed landmarks in the reference")
        data[side+"xy"], data[side+"desc"] = xy, desc
    np.savez(args.output, **data)
