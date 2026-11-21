"""Calibrated RAFT-Stereo depth for the live camera and offline comparisons."""
from functools import lru_cache
from pathlib import Path
import sys
from types import SimpleNamespace

import cv2
import numpy as np


@lru_cache(maxsize=1)
def _load_model():
    import torch

    repo = Path(__file__).resolve().parents[1] / '.visionassist/RAFT-Stereo'
    if not repo.is_dir():
        raise FileNotFoundError(f'Missing RAFT-Stereo checkout at {repo}')
    sys.path.insert(0, str(repo))
    from core.raft_stereo import RAFTStereo
    from core.utils.utils import InputPadder
    options = SimpleNamespace(hidden_dims=[128]*3, context_norm='batch', n_downsample=3, n_gru_layers=2,
                              corr_levels=4, corr_radius=4, shared_backbone=True, slow_fast_gru=True,
                              mixed_precision=False, corr_implementation='reg')
    model = RAFTStereo(options)
    weights = torch.load(repo / 'raftstereo-realtime.pth', map_location='cpu', weights_only=True)
    model.load_state_dict({name.removeprefix('module.'): value for name, value in weights.items()})
    return model.eval(), InputPadder


def _disparity(left, right):
    import torch

    model, input_padder = _load_model()
    with torch.inference_mode():
        tensors = [torch.from_numpy(np.ascontiguousarray(im[:, :, ::-1])).permute(2, 0, 1)[None].float()
                   for im in (left, right)]
        padder = input_padder(tensors[0].shape, divis_by=32)
        _, flow = model(*padder.pad(*tensors), iters=7, test_mode=True)
        return -padder.unpad(flow)[0, 0].numpy()


def compute(stereo, left_bgr, right_bgr):
    """Return depth aligned to Camera A, using the same calibration as SGBM."""
    left, right = [cv2.remap(cv2.resize(im, stereo.match_size, interpolation=cv2.INTER_AREA),
                             *maps, cv2.INTER_LINEAR) for im, maps in zip((left_bgr, right_bgr), stereo.maps)]
    disp = _disparity(left, right)
    reverse = _disparity(right[:, ::-1], left[:, ::-1])[:, ::-1]
    right_x = stereo.cols - disp
    index = np.rint(right_x).astype(int).clip(0, disp.shape[1]-1)
    x_min, _, x_max, _ = stereo.window_bounds[1]
    valid = (stereo.left_support & (disp > 0) & (disp < stereo.num_disparities)
             & (right_x >= x_min) & (right_x <= x_max) & (np.abs(disp - reverse[stereo.rows, index]) <= 1))
    z = np.full(disp.shape, np.nan, np.float32)
    np.divide(stereo.fb * stereo.z_scale, disp, out=z, where=valid)
    z[(z < stereo.min_m) | (z > stereo.max_m)] = np.nan
    aligned = cv2.remap(z, stereo.raw_lookup, None, cv2.INTER_NEAREST, borderValue=float('nan'))
    return cv2.resize(aligned, stereo.size, interpolation=cv2.INTER_NEAREST)
