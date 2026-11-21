"""Run from the repository with .visionassist/rtc-env/bin/python <path to this file>."""
import csv
import sys
from pathlib import Path
from types import SimpleNamespace

import av
import cv2
import numpy as np
import torch

project = Path(__file__).resolve().parents[3]
take = project / '.visionassist/video-analysis/buffered-20261120-185228'
raft_repo = project / '.visionassist/RAFT-Stereo'
sys.path[:0] = [str(project / 'cv'), str(raft_repo)]
from core.raft_stereo import RAFTStereo
from core.utils.utils import InputPadder
from stereo_depth import StereoDepth

cv2.setNumThreads(1)
torch.set_num_threads(4)
stereo = StereoDepth.load(project / 'cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json')
options = SimpleNamespace(hidden_dims=[128]*3, context_norm='batch', n_downsample=3, n_gru_layers=2,
                          corr_levels=4, corr_radius=4, shared_backbone=True, slow_fast_gru=True,
                          mixed_precision=False, corr_implementation='reg')
model = RAFTStereo(options)
weights = torch.load(raft_repo / 'raftstereo-realtime.pth', map_location='cpu', weights_only=True)
model.load_state_dict({name.removeprefix('module.'): value for name, value in weights.items()})
model.eval()


@torch.inference_mode()
def disparity(left, right):
    tensors = [torch.from_numpy(np.ascontiguousarray(im[:, :, ::-1])).permute(2, 0, 1)[None].float()
               for im in (left, right)]
    padder = InputPadder(tensors[0].shape, divis_by=32)
    _, flow = model(*padder.pad(*tensors), iters=7, test_mode=True)
    return -padder.unpad(flow)[0, 0].numpy()


def raft_depth(images):
    left, right = [cv2.remap(cv2.resize(im, stereo.match_size, interpolation=cv2.INTER_AREA),
                             *maps, cv2.INTER_LINEAR) for im, maps in zip(images, stereo.maps)]
    disp = disparity(left, right)
    reverse = disparity(right[:, ::-1], left[:, ::-1])[:, ::-1]
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


def color(depth):
    gray = stereo.preview(depth)
    values = np.clip(np.rint((gray.astype(float)-32)*255/223), 0, 255).astype('uint8')
    rgb = cv2.applyColorMap(values, cv2.COLORMAP_TURBO)
    rgb[gray == 0] = 0
    return rgb


def label(canvas, x, y, value, scale=.67):
    cv2.putText(canvas, value, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale,
                (242, 242, 242), 1, cv2.LINE_AA)


with (take/'timestamps.csv').open() as f:
    rows = list(csv.DictReader(f))
assert len(rows) == 47 and len({r['a_id'] for r in rows}) == len({r['b_id'] for r in rows}) == len(rows)
movie = take / 'stereo-depth-comparison.mp4'
temp = take / 'stereo-depth-comparison.partial.mp4'
width, height = stereo.size
with av.open(str(temp), 'w', options={'movflags':'+faststart'}) as container, (take/'comparison.csv').open('w') as metrics:
    stream = container.add_stream('libx264', rate=4)
    stream.width, stream.height, stream.pix_fmt = 3*width, height+104, 'yuv420p'
    stream.options = {'crf':'16', 'preset':'fast', 'g':'1'}
    writer = csv.writer(metrics, lineterminator='\n')
    writer.writerow(['video_frame_1based','pair','elapsed_s','skew_bound_ms','sgbm_valid_pct','raft_valid_pct'])
    for i, row in enumerate(rows, 1):
        pair = int(row['pair'])
        images = [cv2.imread(str(take / f'{pair:04}-{s}.jpg')) for s in 'AB']
        assert all(im is not None and im.shape == (height,width,3) for im in images)
        assert 0 <= int(row['skew_ms']) <= int(row['skew_bound_ms']) <= 65
        sgbm = stereo.compute(*[cv2.cvtColor(im,cv2.COLOR_BGR2GRAY) for im in images])
        raft = raft_depth(images)
        valid = [100*np.isfinite(z).mean() for z in (sgbm,raft)]
        canvas = np.full((height+104, width*3, 3), 22, dtype='uint8')
        canvas[42:42+height] = np.hstack([images[0], color(sgbm), color(raft)])
        for col, title in enumerate(['Camera A',f'StereoSGBM   |   {valid[0]:.1f}% valid',
                                     f'RAFT-Stereo   |   {valid[1]:.1f}% valid']):
            label(canvas, col*width+12, 28, title, .78)
        label(canvas, 12, height+71, f"Frame {i:02}/{len(rows)}    |    Pair {pair:04}    |    Capture +{float(row['elapsed_s']):.3f} s    |    A/B skew bound {row['skew_bound_ms']} ms")
        label(canvas, 12, height+95, 'Same inverse-depth scale: 0.25 m (warm) to 8 m (cool)     |     Black: unknown')
        frame = av.VideoFrame.from_ndarray(canvas, format='bgr24')
        for packet in stream.encode(frame):
            container.mux(packet)
        writer.writerow([i,pair,row['elapsed_s'],row['skew_bound_ms'],*[round(v,3) for v in valid]])
        if i == 1 or i%10 == 0: print('Encoded',i,'of',len(rows),flush=True)
    for packet in stream.encode():
        container.mux(packet)
temp.replace(movie)
