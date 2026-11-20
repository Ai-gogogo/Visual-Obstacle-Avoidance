"""Metric stereo depth in the original Camera A image coordinates."""

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

DEFAULT_CONFIG = Path(__file__).with_name("stereo_config.json")


def array(value, shape, name):
    data = np.asarray(value, dtype=np.float64)
    if data.shape != shape or not np.isfinite(data).all():
        raise ValueError(f"Invalid {name}, expected finite numbers of shape {shape}")
    return data


def camera_parameters(camera):
    fx, fy, cx, cy = array([camera[k] for k in ("fx", "fy", "cx", "cy")], (4,), "intrinsics")
    if min(fx, fy) <= 0:
        raise ValueError("Camera focal lengths must be positive (pixels)")
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]]), array(camera["distortion"], (5,), "distortion")


class StereoDepth:
    @classmethod
    def load(cls, path):
        config = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(config, dict) or type(config.get("enabled")) is not bool:
            raise ValueError("Set enabled to true or false")
        return cls(config) if config["enabled"] else None

    def __init__(self, config):
        self.config = config.copy()
        self.square_units = config.get("units") == "checker_squares_only"
        width, height = config["image_size_px"]
        count = config["num_disparities"]
        if (type(width) is not int or type(height) is not int or min(width, height) < 16
                or type(count) is not int or count <= 0 or count % 16 or count + 8 >= width):
            raise ValueError("Set image_size_px and a positive num_disparities multiple of 16 below image width")
        self.size = (width, height)
        divisor = config.get("matching_divisor", 1)
        if (type(divisor) is not int or divisor < 1 or width % divisor or height % divisor
                or min(width, height) // divisor < 16 or count + 8 >= width // divisor):
            raise ValueError("Invalid matching_divisor or disparity range for matching dimensions")
        width, height = width // divisor, height // divisor
        self.match_size = (width, height)
        self.min_m, self.max_m, baseline = array(
            [config["min_depth_m"], config["max_depth_m"], config["baseline_m"]], (3,), "metric limits")
        self.skew_ms = config["max_pair_skew_ms"]
        if not (0 < self.min_m < self.max_m and baseline > 0 and type(self.skew_ms) is int and 0 < self.skew_ms <= 250):
            raise ValueError("Check metric range, positive baseline and max_pair_skew_ms (1–250)")
        ka, da = camera_parameters(config["camera_A"])
        self.camera_a = ka, da
        kb, db = camera_parameters(config["camera_B"])
        if divisor != 1:
            ka, kb = ka.copy(), kb.copy()
            for intrinsic in (ka, kb):
                intrinsic[0, 0] /= divisor
                intrinsic[1, 1] /= divisor
                intrinsic[:2, 2] = (intrinsic[:2, 2] + .5) / divisor - .5
        rotation = array(config["rotation_A_to_B"], (3, 3), "rotation_A_to_B")
        direction = array(config["translation_direction_A_to_B"], (3,), "translation_direction_A_to_B")
        if (not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-4)
                or not math.isclose(np.linalg.det(rotation), 1, abs_tol=1e-4)
                or not math.isclose(np.linalg.norm(direction), 1, abs_tol=1e-4)):
            raise ValueError("Expected a proper rotation and a unit translation direction")
        ra, rb, pa, pb, _, roi_a, roi_b = cv2.stereoRectify(
            ka, da, kb, db, self.match_size, rotation, direction * baseline, flags=cv2.CALIB_ZERO_DISPARITY, alpha=0)
        if pb[0, 3] >= 0 or abs(pb[0, 3]) <= abs(pb[1, 3]) or pa[0, 0] <= 0:
            raise ValueError("Use a horizontal rig with A on the left, B on the right")
        self.fb = -pb[0, 3]
        self.maps = [cv2.initUndistortRectifyMap(k, d, r, p, self.match_size, cv2.CV_32FC1)
                     for k, d, r, p in [(ka, da, ra, pa), (kb, db, rb, pb)]]
        # Raw A pixels -> rectified A sampling coordinates. Rotate rectified Z back to A's optical axis.
        y, x = np.indices((height, width), dtype=np.float32)
        grid = np.stack([x, y], axis=-1)
        self.raw_lookup = cv2.undistortPoints(grid.reshape(-1, 1, 2), ka, da, R=ra, P=pa).reshape(height, width, 2)
        self.z_scale = (ra[0, 2] * (x-pa[0, 2]) / pa[0, 0] + ra[1, 2] * (y-pa[1, 2]) / pa[1, 1] + ra[2, 2])
        self.cols = x
        self.rows = np.arange(height)[:, None]
        # A 5 x 5 matching window must be entirely inside each rectified camera.
        # Bounds include a two-pixel margin around its center in each image.
        self.window_bounds = [(x+2, y+2, x+w-3, y+h-3) for x, y, w, h in (roi_a, roi_b)]
        for xmin, ymin, xmax, ymax in self.window_bounds:
            if xmin > xmax or ymin > ymax:
                raise ValueError("Calibration leaves no valid matching window")
        (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = self.window_bounds
        if max(ay0, by0) > min(ay1, by1) or ax1 <= bx0 or ax0 - bx1 >= count:
            raise ValueError("Calibration leaves no shared disparity region")
        self.left_support = (x >= ax0) & (x <= ax1) & (y >= max(ay0, by0)) & (y <= min(ay1, by1))
        self.num_disparities = count
        self.matchers = [cv2.StereoSGBM_create(minDisparity=start, numDisparities=count,
                         blockSize=5, P1=8*25, P2=32*25, uniquenessRatio=12,
                         speckleWindowSize=50, speckleRange=2, disp12MaxDiff=1)
                         for start in (0, 1-count)]

    def for_usb_low_output(self):
        """Match the same lens after the phone crops 240 rows per end and resizes."""
        if self.size != (1080, 1920):
            raise ValueError("USB low output needs the original portrait calibration")
        cfg = dict(self.config, image_size_px=[480, 640], matching_divisor=2, num_disparities=176)
        for side in ("camera_A", "camera_B"):
            cam = self.config[side]
            scale = 4 / 9
            cfg[side] = dict(cam, fx=cam["fx"]*scale, fy=cam["fy"]*scale,
                             cx=(cam["cx"]+.5)*scale-.5, cy=(cam["cy"]-240+.5)*scale-.5)
        return StereoDepth(cfg)

    def compute(self, left, right):
        """Inputs are grayscale uint8, result is float32 axial meters; invalid pixels are NaN."""
        if any(image.shape != self.size[::-1] or image.dtype != np.uint8 for image in (left, right)):
            raise ValueError(f"Both grayscale inputs must match calibrated size {self.size}")
        if self.match_size != self.size:
            left, right = [cv2.resize(image, self.match_size, interpolation=cv2.INTER_AREA)
                           for image in (left, right)]
        a, b = [cv2.remap(image, *maps, cv2.INTER_LINEAR) for image, maps in zip((left, right), self.maps)]
        # SGBM skips an entire disparity range at its search border. Extend that
        # border for the cost computation, then reject matches touching padding.
        n = self.num_disparities
        def match_disparity(matcher, first, second, pad_left, pad_right):
            first = cv2.copyMakeBorder(first, 0, 0, pad_left, pad_right, cv2.BORDER_REPLICATE)
            second = cv2.copyMakeBorder(second, 0, 0, pad_left, pad_right, cv2.BORDER_REPLICATE)
            values = matcher.compute(first, second)[:, pad_left:pad_left+self.match_size[0]]
            return values.astype(np.float32) / 16

        disp = match_disparity(self.matchers[0], a, b, n, 0)
        reverse = match_disparity(self.matchers[1], b, a, 0, n)
        right_x = self.cols - disp
        bx = np.rint(right_x).astype(np.int32)
        match = reverse[self.rows, bx.clip(0, self.match_size[0]-1)]
        ax0, _, ax1, _ = self.window_bounds[0]
        bx0, _, bx1, _ = self.window_bounds[1]
        support = (self.left_support & (right_x >= bx0) & (right_x <= bx1)
                   & (bx - match >= ax0) & (bx - match <= ax1))
        gray = a.astype(np.float32)
        variance = cv2.blur(gray*gray, (5, 5)) - cv2.blur(gray, (5, 5))**2
        valid = (support & (disp > 0) & (match < 0)
                 & (match > -self.num_disparities) & (np.abs(disp + match) <= 1) & (variance > 9))
        z = np.full(disp.shape, np.nan, np.float32)
        np.divide(self.fb * self.z_scale, disp, out=z, where=valid)
        z[(z < self.min_m) | (z > self.max_m)] = np.nan
        depth = cv2.remap(z, self.raw_lookup, None, cv2.INTER_NEAREST, borderValue=float("nan"))

        if self.match_size != self.size:
            depth = cv2.resize(depth, self.size, interpolation=cv2.INTER_NEAREST)
        return depth

    def preview(self, depth):
        """Black is unknown. Near is bright, far is dark, on a fixed inverse-depth scale."""
        valid = np.isfinite(depth)
        out = np.zeros(depth.shape, np.uint8)
        intensity = (1/depth[valid] - 1/self.max_m) / (1/self.min_m - 1/self.max_m)
        out[valid] = 32 + np.rint(223 * intensity.clip(0, 1)).astype(np.uint8)
        return out


def object_depth(depth, box):
    """Representative surface in the central half of a detection, in axial meters."""
    h, w = depth.shape
    x1, y1, x2, y2 = np.asarray(box) * [w, h, w, h]
    dx, dy = (x2-x1)/4, (y2-y1)/4
    region = depth[math.ceil(y1+dy):math.ceil(y2-dy), math.ceil(x1+dx):math.ceil(x2-dx)]
    values = region[np.isfinite(region)]
    if values.size < max(24, region.size * .4):
        return None
    low, middle, high = np.percentile(values, [25, 50, 75])
    if high-low > middle * .2:
        return None
    return round(float(middle), 3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("left")
    parser.add_argument("right")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", required=True, type=Path, help="New result directory")
    args = parser.parse_args()
    try:
        stereo = StereoDepth.load(args.config)
        if stereo is None:
            raise ValueError("Fill in calibration and set enabled to true in the configuration")
        images = [cv2.imread(path, cv2.IMREAD_GRAYSCALE) for path in (args.left, args.right)]
        if any(i is None for i in images):
            raise ValueError("Cannot decode input images")
        depth = stereo.compute(*images)
        args.output.mkdir(parents=True, exist_ok=False)
        np.save(args.output / "depth_m.npy", depth)
        if not cv2.imwrite(str(args.output / "depth_preview.png"), stereo.preview(depth)):
            raise OSError("Cannot save preview")
    except (OSError, KeyError, ValueError, TypeError, cv2.error) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
