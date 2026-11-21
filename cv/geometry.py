"""Camera geometry shared by stereo and perception modules."""

import cv2
import numpy as np


def deproject(pixels, depth, camera):
    """Convert raw camera pixels and axial depth to camera-space XYZ points."""
    xy = cv2.undistortPoints(np.asarray(pixels, np.float32).reshape(-1, 1, 2), *camera).reshape(-1, 2)
    return np.column_stack((xy, np.ones(len(xy)))) * np.asarray(depth).reshape(-1, 1)
