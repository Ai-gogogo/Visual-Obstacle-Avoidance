from itertools import count
import unittest

import cv2
import numpy as np

from geometry import ground_axes, pitch_normal
from path_intrusion import Corridor, IntrusionPredictor
from road_edge import DEFAULT_ROAD_CONFIG
from tracking import FrameTracker

W, H = 320, 192
K = np.array([[240., 0, 160], [0, 240., 96], [0, 0, 1]])
CAMERA = (K, np.zeros(5))


class Replay:
    """A fixed textured wall behind a known 3-D target; move the camera independently."""
    def __init__(self):
        self.wall = np.random.default_rng(340).integers(0, 256, (H, W), dtype=np.uint8)
        self.predictor = IntrusionPredictor(CAMERA, Corridor.load(DEFAULT_ROAD_CONFIG))
        self.tracker = FrameTracker("A", "A", count(1))

    def frame(self, x, yaw=0., dx=0., z=3., label="bicycle", pitch=0., roll=0.):
        rotation = cv2.Rodrigues(np.radians([pitch, yaw, roll]))[0]
        translation = rotation @ [-dx, 0., 0.]
        plane = K @ (rotation + np.outer(translation, [0., 0., 1/5])) @ np.linalg.inv(K)
        gray = cv2.warpPerspective(self.wall, plane, (W, H))
        v, u = np.indices((H, W))
        rays = np.stack([(u-160)/240, (v-96)/240, np.ones_like(u)], axis=-1)
        depth = (5 / (rays @ rotation[:, 2])).astype(np.float32)
        center = rotation @ [x, .1, z] + translation
        u, v = (K @ center)[:2]/center[2]
        half_w, half_h = 240*np.array([.21, .38])/center[2]
        box = np.array([u-half_w, v-half_h, u+half_w, v+half_h])
        x1,y1,x2,y2 = box.astype(int)
        gray[max(0,y1):y2,max(0,x1):x2] = 110
        depth[max(0,y1):y2,max(0,x1):x2] = center[2]
        obj = dict(label=label, confidence=.92, position='center', bbox=(box/[W,H,W,H]).clip(0,1).tolist(),
                   depth_m=center[2])
        return gray, depth, obj

    def step(self, i, x, yaw=0., dx=0., stamp=None, blank=False, **kwargs):
        gray, depth, obj = self.frame(x, yaw, dx, **kwargs)
        stamp = 1000+i*220 if stamp is None else stamp
        if blank:
            gray.fill(110)
        self.tracker.update([obj], stamp)
        self.predictor.update(gray, depth, [obj], stamp)
        return obj.get("intrusion")


class IntrusionTests(unittest.TestCase):
    def test_both_sides_and_user_turning_while_bicycle_crosses(self):
        for side, sign in [('left', -1), ('right', 1)]:
            replay = Replay()
            values = [replay.step(i, sign*(1.62-i*.16), yaw=.6*i, pitch=.25*i, roll=.18*i)
                      for i in range(5)]
            self.assertEqual(values[:2], [None, None])
            predictions = [v for v in values if v]
            self.assertTrue(predictions, side)
            self.assertTrue(all(v['from_side'] == side and 0 < v['eta_s'] <= 2 for v in predictions))

    def test_stationary_person_during_pan_and_sidestep(self):
        for yaw, dx in [(-1.6, 0), (0, .095), (-.7, .06)]:
            replay = Replay()
            for i in range(6):
                self.assertIsNone(replay.step(i, 1.47, i*yaw, i*dx, label="person"))

    def test_background_failure_gap_and_fast_turn(self):
        for condition in ('blank', 'fast_turn', 'gap'):
            replay = Replay()
            for i in range(3):
                kwargs = {}
                if condition == 'blank':
                    kwargs['blank'] = i == 2
                elif condition == 'gap':
                    kwargs['stamp'] = [1000,1220,2700][i]
                else:
                    kwargs['yaw'] = [0,0,-10][i]
                self.assertIsNone(replay.step(i, 1.55-i*.18, **kwargs), condition)

    def test_parallel_outgoing_already_inside_or_too_far(self):
        cases = [(1.1, 0., 3.), (1.05, .12, 3.), (.45, -.08, 3.), (2.1,-.2,8.)]
        for start, step, z in cases:
            replay = Replay()
            for i in range(5):
                self.assertIsNone(replay.step(i, start+i*step, z=z), (start, i))

    def test_missing_id_and_missing_depth_do_not_join_observations(self):
        for missing in ['track_id', 'depth_m']:
            replay = Replay()
            for i in range(4):
                gray, depth, obj = replay.frame(1.6-i*.14)
                obj['track_id'] = 'A-1'
                if i == 2:
                    del obj[missing]
                replay.predictor.update(gray,depth,[obj],1000+i*220)
                self.assertNotIn('intrusion',obj)


    def test_entry_distance_uses_dynamic_ground_forward(self):
        predictor = Replay().predictor
        center = np.array([1., 0., 7.])
        velocity = np.array([-1., 0., 0.])
        self.assertIsNone(predictor.entry_time(center, .2, velocity))
        axes = ground_axes(pitch_normal(np.radians(40)))
        self.assertAlmostEqual(predictor.entry_time(center, .2, velocity, axes), .35)
        self.assertIsNone(predictor.entry_time(center, .2, velocity, axes=None))
