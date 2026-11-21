"""Pixel-space morphology for boolean instance masks."""

from functools import lru_cache
from typing import NamedTuple

import cv2
import numpy as np


@lru_cache(maxsize=8)
def _kernel(radius_px):
    if radius_px < 0:
        raise ValueError("mask radius must be nonnegative")
    side = 2 * radius_px + 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (side, side))


def erode_mask(mask, radius_px=2):
    """Shrink a foreground silhouette, treating pixels outside the frame as background."""
    pixels = np.asarray(mask, dtype=bool).view(np.uint8)
    return cv2.erode(pixels, _kernel(radius_px),
                     borderType=cv2.BORDER_CONSTANT, borderValue=0).view(bool)


def dilate_mask(mask, radius_px=4):
    """Expand a foreground silhouette by the given pixel radius."""
    pixels = np.asarray(mask, dtype=bool).view(np.uint8)
    return cv2.dilate(pixels, _kernel(radius_px)).view(bool)


class MaskSamples(NamedTuple):
    pixels: np.ndarray
    values: np.ndarray
    mask_area: int


class InstanceMask:
    """Frame-local silhouette shared by exclusion, distance and height."""

    def __init__(self, pixels):
        self.pixels = np.asarray(pixels, dtype=bool)
        self._depth = None
        self._samples = None

    def sample(self, depth):
        if self._depth is not depth:
            self._samples = sample_instance(depth, self.pixels)
            self._depth = depth
        return self._samples


def sample_instance(depth, mask):
    """Use the eroded interior, retrying the full silhouette below 24 valid pixels."""
    if mask is None:
        return None
    if isinstance(mask, InstanceMask):
        return mask.sample(depth)
    mask = np.asarray(mask, dtype=bool)
    if mask.shape != depth.shape:
        raise ValueError("instance mask and metric depth must have the same shape")
    # Crop to the actual silhouette. Zero-border erosion gives the same pixels
    # as full-frame erosion and avoids scanning the whole image for each statistic.
    x, y, w, h = cv2.boundingRect(mask.view(np.uint8))
    if not w or not h:
        return None
    region = np.s_[y:y+h, x:x+w]
    silhouette = mask[region]
    local = depth[region]
    observed = np.isfinite(local) & (local > 0)
    interior = erode_mask(silhouette, radius_px=2)
    for selection in (interior, silhouette):
        valid = selection & observed
        indices = np.flatnonzero(valid)
        if indices.size >= 24:
            # Original image offsets also index the cached camera rays used for height.
            pixels = indices + (indices // w) * (depth.shape[1] - w) + y * depth.shape[1] + x
            return MaskSamples(pixels, depth.flat[pixels], np.count_nonzero(selection))
    return None
