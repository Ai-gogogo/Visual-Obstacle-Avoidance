"""Camera geometry shared by stereo and perception modules."""

import cv2
import numpy as np


def deproject(pixels, depth, camera):
    """Convert raw camera pixels and axial depth to camera-space XYZ points."""
    xy = cv2.undistortPoints(np.asarray(pixels, np.float32).reshape(-1, 1, 2), *camera).reshape(-1, 2)
    return np.column_stack((xy, np.ones(len(xy)))) * np.asarray(depth).reshape(-1, 1)


def ground_axes(normal):
    """Return unit forward and right axes in the plane, with camera-facing heading."""
    lateral = np.cross([0., 0., 1.], normal)
    length = np.linalg.norm(lateral)
    if length < 1e-6:
        return None
    lateral /= length
    return np.cross(normal, lateral), lateral


def pitch_normal(pitch_rad):
    """Up direction for the static, zero-roll camera model."""
    return np.array([0., -np.cos(pitch_rad), -np.sin(pitch_rad)])
