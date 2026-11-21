"""Pixel-space morphology for boolean instance masks."""

import cv2
import numpy as np


def _kernel(radius_px):
    if radius_px < 0:
        raise ValueError("mask radius must be nonnegative")
    side = 2 * radius_px + 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (side, side))


def erode_mask(mask, radius_px=2):
    """Shrink a foreground silhouette, treating pixels outside the frame as background."""
    return cv2.erode(np.asarray(mask, dtype=np.uint8), _kernel(radius_px),
                     borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)


def dilate_mask(mask, radius_px=4):
    """Expand a foreground silhouette by the given pixel radius."""
    return cv2.dilate(np.asarray(mask, dtype=np.uint8), _kernel(radius_px)).astype(bool)
