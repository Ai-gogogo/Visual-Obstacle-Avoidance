"""Run from the repository with .visionassist/rtc-env/bin/python <path to this file>."""
import argparse
from colorsys import hls_to_rgb
import csv
import json
import sys
from pathlib import Path

import av
import cv2
import numpy as np
import torch
from PIL import Image

project = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description='Compare stereo depth and Camera A semantic labels on saved frame pairs.')
parser.add_argument('--take', type=Path, default=project / '.visionassist/video-analysis/buffered-20261120-185228')
parser.add_argument('--calibration', type=Path, default=project / 'cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json')
args = parser.parse_args()
take = args.take
sys.path.insert(0, str(project / 'cv'))
import raft_depth
from scene_segmentation import DEFAULT_SCENE_MODEL, SceneSegmenter
from stereo_depth import StereoDepth

cv2.setNumThreads(1)
torch.set_num_threads(4)
stereo = StereoDepth.load(args.calibration)
segmenter = SceneSegmenter(DEFAULT_SCENE_MODEL)
class_names = json.loads((project / 'web/public/ade20k-labels.json').read_text(encoding='utf-8'))
# Match the live semantic preview's hue sequence and low-confidence color.
palette = np.tile([58, 49, 40], (256, 1)).astype(np.uint8)
for class_id in range(len(class_names)):
    hue = (class_id * 137.508 % 360) / 360
    palette[class_id] = [round(255 * value) for value in reversed(hls_to_rgb(hue, .57, .65))]



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
metrics_temp = take / 'comparison.partial.csv'
capture_width, capture_height = stereo.size
width = min(capture_width, 960)
height = round(capture_height * width / capture_width / 2) * 2
metric_rows = []
with av.open(str(temp), 'w', options={'movflags':'+faststart'}) as container:
    stream = container.add_stream('libx264', rate=4)
    stream.width, stream.height, stream.pix_fmt = 4*width, height+104, 'yuv420p'
    stream.options = {'crf':'16', 'preset':'fast', 'g':'1'}
    for i, row in enumerate(rows, 1):
        pair = int(row['pair'])
        images = [cv2.imread(str(take / (row.get(side.lower()+'_file') or f'{pair:04}-{side}.jpg'))) for side in 'AB']
        if any(im is None or im.shape != (capture_height, capture_width, 3) for im in images):
            raise ValueError(f'Pair {pair} requires two {capture_width} x {capture_height} images for this calibration.')
        if not 0 <= float(row['skew_ms']) <= float(row['skew_bound_ms']) <= 65:
            raise ValueError(f'Pair {pair} exceeds the synchronization limit.')
        sgbm = stereo.compute(*[cv2.cvtColor(im,cv2.COLOR_BGR2GRAY) for im in images])
        raft = raft_depth.compute(stereo, *images)
        valid = [100*np.isfinite(z).mean() for z in (sgbm,raft)]
        left_rgb = Image.fromarray(cv2.cvtColor(images[0], cv2.COLOR_BGR2RGB))
        scene = segmenter.labels(left_rgb)
        tiles = [cv2.resize(images[0], (width,height), interpolation=cv2.INTER_AREA)]
        tiles.extend(cv2.resize(view, (width,height), interpolation=cv2.INTER_NEAREST)
                     for view in (color(sgbm), color(raft), palette[scene]))
        canvas = np.full((height+104, width*4, 3), 22, dtype='uint8')
        canvas[42:42+height] = np.hstack(tiles)
        for col, title in enumerate(['Camera A',f'StereoSGBM   |   {valid[0]:.1f}% valid',
                                     f'RAFT-Stereo   |   {valid[1]:.1f}% valid', 'Camera A segmentation']):
            label(canvas, col*width+12, 28, title, .78)
        label(canvas, 12, height+71, f"Frame {i:02}/{len(rows)}    |    Pair {pair:04}    |    Capture +{float(row['elapsed_s']):.3f} s    |    A/B skew bound {row['skew_bound_ms']} ms")
        label(canvas, 12, height+95, f'Same inverse-depth scale: {stereo.min_m:g} m (warm) to {stereo.max_m:g} m (cool)     |     Black: unknown')
        classes, counts = np.unique(scene, return_counts=True)
        for j, class_id in enumerate(classes[np.argsort(-counts)[:2]]):
            x, y = 3*width+12, height+71+j*24
            cv2.rectangle(canvas, (x,y-13), (x+13,y), tuple(int(v) for v in palette[class_id]), -1)
            label(canvas, x+22, y, class_names[class_id] if class_id < len(class_names) else 'Uncertain')
        frame = av.VideoFrame.from_ndarray(canvas, format='bgr24')
        for packet in stream.encode(frame):
            container.mux(packet)
        metric_rows.append([i,pair,row['elapsed_s'],row['skew_bound_ms'],*[round(v,3) for v in valid]])
        if i == 1 or i%10 == 0: print('Encoded',i,'of',len(rows),flush=True)
    for packet in stream.encode():
        container.mux(packet)
with metrics_temp.open('w', newline='') as metrics:
    writer = csv.writer(metrics, lineterminator='\n')
    writer.writerow(['video_frame_1based','pair','elapsed_s','skew_bound_ms','sgbm_valid_pct','raft_valid_pct'])
    writer.writerows(metric_rows)
metrics_temp.replace(take / 'comparison.csv')
temp.replace(movie)
