"""Run from the repository with .visionassist/rtc-env/bin/python <path to this file>."""
import argparse
from colorsys import hls_to_rgb
import csv
from itertools import count
import json
import sys
from pathlib import Path

import av
import cv2
import numpy as np
import torch
from PIL import Image
from ultralytics import YOLO

project = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description='Compare stereo depth and Camera A semantic labels on saved frame pairs.')
parser.add_argument('--take', type=Path, default=project / '.visionassist/video-analysis/buffered-20261120-185228')
parser.add_argument('--calibration', type=Path, default=project / 'cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json')
parser.add_argument('--road-alerts', action='store_true', help='Include the optional live road-edge marker')
args = parser.parse_args()
take = args.take
sys.path.insert(0, str(project / 'cv'))
import raft_depth
from detect_image import DEFAULT_WEIGHTS, detect
from geometry import ground_axes
from obstacles import PlaneObstacles
from path_intrusion import Corridor, IntrusionPredictor, background_mask
from plane_ransac import fit_support_plane, object_height_m
from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge
from scene_segmentation import DEFAULT_SCENE_MODEL, SceneSegmenter
from stereo_depth import StereoDepth, object_depth
from tracking import FrameTracker

cv2.setNumThreads(1)
torch.set_num_threads(4)
stereo = StereoDepth.load(args.calibration)
segmenter = SceneSegmenter(DEFAULT_SCENE_MODEL)
if not DEFAULT_WEIGHTS.is_file():
    parser.error(f'Missing detection weights: {DEFAULT_WEIGHTS}. See cv/README.md for setup.')
detector = YOLO(str(DEFAULT_WEIGHTS), task='detect')
device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
tracker = FrameTracker('recording', 'A', count(1))
plane_config = PlaneObstacles.load(DEFAULT_ROAD_CONFIG, force=True).fit
corridor = Corridor.load(DEFAULT_ROAD_CONFIG)
intrusion = IntrusionPredictor(stereo.camera_a, corridor) if corridor and not stereo.square_units else None
road = RoadEdge.load(DEFAULT_ROAD_CONFIG, stereo) if args.road_alerts else None
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


def paint_camera_a(tile, objects, weak_objects, edge):
    height, width = tile.shape[:2]
    cyan = (255, 233, 140)
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(.42, max(width, height) / 1300)
    thickness = max(2, round(width / 240))
    captions = []
    for obj, weak in [(obj, False) for obj in objects] + [(obj, True) for obj in weak_objects]:
        x1, y1, x2, y2 = np.rint(np.asarray(obj['bbox']) * [width, height, width, height]).astype(int)
        if weak:
            for x in range(x1, x2, 8):
                for y in (y1, y2):
                    cv2.line(tile, (x, y), (min(x+4, x2), y), cyan, thickness)
            for y in range(y1, y2, 8):
                for x in (x1, x2):
                    cv2.line(tile, (x, y), (x, min(y+4, y2)), cyan, thickness)
        else:
            cv2.rectangle(tile, (x1, y1), (x2, y2), cyan, thickness)
        confidence = round(obj['confidence'] * 100)
        caption = f"{obj['label']} #{obj['track_id']} | {confidence}% | {obj['position']}"
        if 'depth_m' in obj:
            caption += f" | {obj['depth_m']:.2f} m"
        if 'height_above_plane_m' in obj:
            caption += f" | H {obj['height_above_plane_m']:.2f} m"
        if crossing := obj.get('intrusion'):
            caption += f" | may cross from {crossing['from_side']} (~{crossing['eta_s']:.1f} s)"
        (text_width, _), _ = cv2.getTextSize(caption, font, font_scale, 1)
        scale = min(font_scale, font_scale * (width-10) / max(text_width, 1))
        (text_width, text_height), baseline = cv2.getTextSize(caption, font, scale, 1)
        left = max(0, min(x1, width-text_width-8))
        right = left + text_width + 8
        bar_height = text_height + baseline + 5
        preferred = max(0, min(y1-bar_height, height-bar_height))
        # Keep crowded labels readable by trying the nearest free row.
        rows = sorted(range(0, height-bar_height+1), key=lambda y: abs(y-preferred))
        for top in rows:
            bottom = top + bar_height
            if all(right < l or left > r or bottom < t or top > b for l, t, r, b, *_ in captions):
                captions.append((left, top, right, bottom, text_height, caption, scale))
                break
    for left, top, right, bottom, text_height, caption, scale in captions:
        cv2.rectangle(tile, (left, top), (right, bottom), cyan, -1)
        cv2.putText(tile, caption, (left+4, top+text_height+2), font, scale, (49, 32, 16), 1, cv2.LINE_AA)
    if edge and edge.get('point'):
        u, v = edge['point']
        cv2.circle(tile, (round(u*width), round(v*height)), max(5, width//65), (76, 212, 255), thickness)


def camera_analysis(image, gray, depth, stamp):
    candidates = detect(detector, image, device=device, confidence=.25)
    objects = [obj for obj in candidates if obj['confidence'] >= .4]
    tracker.update(objects, stamp)
    weak = tracker.preview_continuations(
        [obj for obj in candidates if obj['confidence'] < .4], stamp,
        {obj['track_id'] for obj in objects})
    if stereo.square_units:
        return objects, weak, None

    edge = None
    for obj in objects:
        distance = object_depth(depth, obj['bbox'])
        if distance is not None:
            obj['depth_m'] = distance
    support = None
    if road is not None:
        road_masks = road.segment(image, road.confidence)
        support = road_masks[0] | road_masks[1]
    if support is None or not support.any():
        support = np.arange(depth.shape[0])[:, None] >= .45 * depth.shape[0]
    foreground = [obj for obj in objects if obj['label'] != 'dining table']
    candidate = background_mask(depth.shape, foreground).astype(bool) & support
    plane = fit_support_plane(depth, stereo.camera_a, candidate, config=plane_config)
    fresh = plane if plane.validated else None
    axes = ground_axes(fresh.normal) if fresh is not None else None
    if fresh is not None:
        for obj in objects:
            height = object_height_m(depth, stereo.camera_a, fresh, obj['bbox'])
            if height is not None:
                obj['height_above_plane_m'] = height['median_m']
    if intrusion is not None:
        intrusion.update(gray, depth, objects, stamp, axes=axes)
    if road is not None:
        edge = road.locate(*road_masks, depth, axes=axes, plane=fresh, camera=stereo.camera_a)
    return objects, weak, edge


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
canvas_height = height + 108
with av.open(str(temp), 'w', options={'movflags':'+faststart'}) as container:
    stream = container.add_stream('libx264', rate=4)
    stream.width, stream.height, stream.pix_fmt = 4*width, canvas_height, 'yuv420p'
    stream.options = {'crf':'16', 'preset':'fast', 'g':'1'}
    for i, row in enumerate(rows, 1):
        pair = int(row['pair'])
        images = [cv2.imread(str(take / (row.get(side.lower()+'_file') or f'{pair:04}-{side}.jpg'))) for side in 'AB']
        if any(im is None or im.shape != (capture_height, capture_width, 3) for im in images):
            raise ValueError(f'Pair {pair} requires two {capture_width} x {capture_height} images for this calibration.')
        if not 0 <= float(row['skew_ms']) <= float(row['skew_bound_ms']) <= 65:
            raise ValueError(f'Pair {pair} exceeds the synchronization limit.')
        gray = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for im in images]
        sgbm = stereo.compute(*gray)
        raft = raft_depth.compute(stereo, *images)
        valid = [100*np.isfinite(z).mean() for z in (sgbm,raft)]
        left_rgb = Image.fromarray(cv2.cvtColor(images[0], cv2.COLOR_BGR2RGB))
        scene = segmenter.labels(left_rgb)
        camera_a = cv2.resize(images[0], (width,height), interpolation=cv2.INTER_AREA)
        stamp = round(float(row['elapsed_s']) * 1000)
        paint_camera_a(camera_a, *camera_analysis(left_rgb, gray[0], raft, stamp))
        tiles = [camera_a]
        tiles.extend(cv2.resize(view, (width,height), interpolation=cv2.INTER_NEAREST)
                     for view in (color(sgbm), color(raft), palette[scene]))
        canvas = np.full((canvas_height, width*4, 3), 22, dtype='uint8')
        canvas[42:42+height] = np.hstack(tiles)
        for col, title in enumerate(['Camera A | YOLO',f'StereoSGBM   |   {valid[0]:.1f}% valid',
                                     f'RAFT-Stereo   |   {valid[1]:.1f}% valid', 'Camera A segmentation']):
            label(canvas, col*width+12, 28, title, .78)
        label(canvas, 12, height+71, f"Frame {i:02}/{len(rows)}    |    Pair {pair:04}    |    Capture +{float(row['elapsed_s']):.3f} s    |    A/B skew bound {row['skew_bound_ms']} ms")
        label(canvas, 12, height+95, f'Same inverse-depth scale: {stereo.min_m:g} m (warm) to {stereo.max_m:g} m (cool)     |     Black: unknown')
        if not stereo.square_units:
            label(canvas, width*2+12, height+95, 'YOLO distances and heights use RAFT-Stereo', .55)
        classes, counts = np.unique(scene, return_counts=True)
        for j, class_id in enumerate(classes[np.argsort(-counts, kind='stable')[:8]]):
            col, line = divmod(j, 4)
            x, y = 3*width + col*(width//2) + 12, height + 57 + line*14
            cv2.rectangle(canvas, (x, y-10), (x+10, y), tuple(int(v) for v in palette[class_id]), -1)
            name = class_names[class_id] if class_id < len(class_names) else 'Uncertain'
            label(canvas, x+16, y, name, .48)
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
