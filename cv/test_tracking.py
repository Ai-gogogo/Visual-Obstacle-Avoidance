import unittest
from itertools import count

from tracking import FrameTracker


def object_at(x, label="chair"):
    return {"label": label, "bbox": [x, 0.2, x + 0.18, 0.6]}


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.tracker = FrameTracker("pair", "A", count(1))

    def ids(self, ms, objects):
        return [o["track_id"] for o in self.tracker.update(objects, ms)]

    def test_same_class_crossing_survives_detection_order_changes(self):
        first, second = self.ids(0, [object_at(.14), object_at(.72)])
        for step in range(1, 9):
            moving_right = object_at(.14 + .055 * step)
            moving_left = object_at(.72 - .055 * step)
            if step % 2:
                self.assertEqual(self.ids(step * 220, [moving_left, moving_right]), [second, first])
            else:
                self.assertEqual(self.ids(step * 220, [moving_right, moving_left]), [first, second])

    def test_missed_frames_do_not_publish_ghosts_and_expired_track_gets_new_id(self):
        initial = self.ids(0, [object_at(.2)])
        self.assertEqual(self.ids(220, []), [])
        self.assertEqual(self.ids(500, [object_at(.22)]), initial)
        self.assertNotEqual(self.ids(2000, [object_at(.22)]), initial)

    def test_new_label_or_distant_detection_gets_new_id(self):
        initial = self.ids(0, [object_at(.10)])
        ids = self.ids(220, [object_at(.10, "bottle"), object_at(.75)])
        self.assertTrue(set(initial).isdisjoint(ids))
        self.assertEqual(len(set(ids)), 2)
