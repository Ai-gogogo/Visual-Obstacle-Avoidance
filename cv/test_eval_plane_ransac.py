import unittest
from types import SimpleNamespace

import numpy as np

import eval_plane_ransac as evaluation
from plane_ransac import PlaneConfig
from test_plane_ransac import scene


class SegmentationEvaluationTests(unittest.TestCase):
    def test_paired_depth_retains_floor_between_legs_and_reports_measurement_denominators(self):
        depth, camera, _, _, _, _ = scene(noisy=False)
        silhouette = np.zeros(depth.shape, bool)
        silhouette[420:560, 120:135] = True
        silhouette[420:560, 225:240] = True
        depth[silhouette] = 1.2
        depth.setflags(write=False)
        objects = [dict(label="chair", bbox=[.25, 420/640, .50, 560/640], track_id="A-1")]
        stereo = SimpleNamespace(camera_a=camera)
        baseline, box_objects, *_ = evaluation.segmentation_frame(
            depth, stereo, objects, None, PlaneConfig())
        experiment, seg_objects, *_ = evaluation.segmentation_frame(
            depth, stereo, objects, [silhouette], PlaneConfig())
        self.assertGreater(experiment["eligible_depth_pixels"], baseline["eligible_depth_pixels"])
        self.assertEqual(seg_objects[0]["depth_source"], "mask")
        self.assertAlmostEqual(seg_objects[0]["depth_m"], 1.2)
        self.assertNotEqual(box_objects[0]["depth_m"], 1.2)
        summary = evaluation.segmentation_summary([experiment], seg_objects)
        self.assertEqual((summary["detections"], summary["depth_count"], summary["depth_rate"]), (1, 1, 1))
        self.assertIsNone(summary["height_track_std_median_m"])


if __name__ == "__main__":
    unittest.main()
