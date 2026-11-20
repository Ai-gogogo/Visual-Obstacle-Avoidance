import unittest

import numpy as np

from depth_filters import spatial_depth, StaticMedian


class FilterTests(unittest.TestCase):
    def test_spatial_allows_small_supported_hole_and_preserves_edge(self):
        z = np.ones((11,16),np.float32)
        z[:,8:] = 3
        z[4,4] = np.nan
        z[6:10,2:6] = np.nan
        guide = np.where(np.indices(z.shape)[1]<8,20,200).astype(np.uint8)
        filtered = spatial_depth(z,guide)
        self.assertAlmostEqual(filtered[4,4],1)
        self.assertTrue(np.isnan(filtered[8,4]))
        self.assertTrue(np.allclose(filtered[:,7:9],z[:,7:9]))

    def test_temporal_uses_only_stable_recent_observations(self):
        f = StaticMedian()
        g = np.zeros((4,4),np.uint8)
        def step(key,t,gray,z):
            return f.apply(key,t,gray,np.full(g.shape,z,np.float32))[0,0]
        step('ab',10,g,2); step('ab',20,g,2)
        self.assertEqual(step('ab',30,g,2.1),2)
        self.assertAlmostEqual(step('ab',40,g+90,2.2),2.2,places=5)
        self.assertTrue(np.isnan(step('ab',50,g,np.nan)))
        self.assertEqual(step('new',60,g,3),3)
