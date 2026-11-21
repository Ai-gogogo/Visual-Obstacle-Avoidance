"""Run from the repository with .visionassist/rtc-env/bin/python <path to this file>."""
import argparse
import csv
import sys
from pathlib import Path

import av
import cv2
import numpy as np
import torch

project = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description='Compare StereoSGBM and RAFT-Stereo on saved frame pairs.')
parser.add_argument('--take', type=Path, default=project / '.visionassist/video-analysis/buffered-20261120-185228')
parser.add_argument('--calibration', type=Path, default=project / 'cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json')
args = parser.parse_args()
take = args.take
sys.path.insert(0, str(project / 'cv'))
import raft_depth
from stereo_depth import StereoDepth

cv2.setNumThreads(1)
torch.set_num_threads(4)
stereo = StereoDepth.load(args.calibration)


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
if not rows or any(len({r[key] for r in rows}) != len(rows) for key in ('a_id', 'b_id')):
    raise ValueError('Recording requires unique synchronized frames from both cameras.')
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
        images = [cv2.imread(str(take / (row.get(side.lower()+'_file') or f'{pair:04}-{side}.jpg'))) for side in 'AB']
        if any(im is None or im.shape != (height, width, 3) for im in images):
            raise ValueError(f'Pair {pair} requires two {width} x {height} images for this calibration.')
        if not 0 <= float(row['skew_ms']) <= float(row['skew_bound_ms']) <= 65:
            raise ValueError(f'Pair {pair} exceeds the synchronization limit.')
        sgbm = stereo.compute(*[cv2.cvtColor(im,cv2.COLOR_BGR2GRAY) for im in images])
        raft = raft_depth.compute(stereo, *images)
        valid = [100*np.isfinite(z).mean() for z in (sgbm,raft)]
        canvas = np.full((height+104, width*3, 3), 22, dtype='uint8')
        canvas[42:42+height] = np.hstack([images[0], color(sgbm), color(raft)])
        for col, title in enumerate(['Camera A',f'StereoSGBM   |   {valid[0]:.1f}% valid',
                                     f'RAFT-Stereo   |   {valid[1]:.1f}% valid']):
            label(canvas, col*width+12, 28, title, .78)
        label(canvas, 12, height+71, f"Frame {i:02}/{len(rows)}    |    Pair {pair:04}    |    Capture +{float(row['elapsed_s']):.3f} s    |    A/B skew bound {row['skew_bound_ms']} ms")
        label(canvas, 12, height+95, f'Same inverse-depth scale: {stereo.min_m:g} m (warm) to {stereo.max_m:g} m (cool)     |     Black: unknown')
        frame = av.VideoFrame.from_ndarray(canvas, format='bgr24')
        for packet in stream.encode(frame):
            container.mux(packet)
        writer.writerow([i,pair,row['elapsed_s'],row['skew_bound_ms'],*[round(v,3) for v in valid]])
        if i == 1 or i%10 == 0: print('Encoded',i,'of',len(rows),flush=True)
    for packet in stream.encode():
        container.mux(packet)
temp.replace(movie)
