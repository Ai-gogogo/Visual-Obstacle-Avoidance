"""Ground-plane projections with known physical placements in camera coordinates."""
import unittest
from detect_image import assign_relative_depth


def project(label, x, z, width, height, elevation=0):
    # Level pinhole camera, 1.5 m above ground. All distances here are in metres.
    bottom = .38 + .6 * (1.5 - elevation) / z
    half_width = .3 * width / z
    return {"label": label, "confidence": .9,
            "bbox": [x-half_width, bottom-.6*height/z, x+half_width, bottom]}


class RelativeDepthTests(unittest.TestCase):
    def depths(self, *objects):
        assign_relative_depth(objects)
        return [o["relative_depth"] for o in objects]

    def test_larger_far_object_and_smaller_near_object(self):
        bus = project("bus", .7, 6, 2.5, 3)
        chair = project("chair", .2, 2, .45, .9)
        self.assertGreater(bus["bbox"][2]-bus["bbox"][0], chair["bbox"][2]-chair["bbox"][0])
        self.assertEqual(self.depths(bus, chair), ["far", "near"])
        self.assertEqual(self.depths(chair, bus), ["near", "far"])

    def test_similar_depth_single_and_unsupported_objects(self):
        chair = project("chair", .2, 3, .45, .9)
        self.assertEqual(self.depths(chair), ["unknown"])
        self.assertEqual(self.depths(chair, project("person", .7, 3.2, .55, 1.7)), ["unknown"]*2)
        self.assertEqual(self.depths(chair, project("bottle", .7, 6, .12, .3)), ["unknown"]*2)

    def test_occluded_contact_point_cannot_be_a_depth_reference(self):
        near = project("chair", .2, 2, .45, .9)
        obscured = project("chair", .7, 6, .45, .9)
        occluder = {"label":"backpack", "confidence":.9, "bbox":[.62,.45,.78,.61]}
        self.assertEqual(self.depths(near, obscured, occluder), ["unknown"] * 3)

    def test_elevated_chair_with_conflicting_height_cue_abstains(self):
        raised = project("chair", .2, 2, .45, .9, elevation=1.4)
        floor = project("chair", .7, 4, .45, .9)
        self.assertEqual(self.depths(raised, floor), ["unknown", "unknown"])

    def test_middle_and_cropped_ground_contact(self):
        near = project("chair", .2, 2, .45, .9)
        middle = project("chair", .4, 3, .45, .9)
        far = project("chair", .6, 6, .45, .9)
        clipped = project("chair", .8, 1.45, .45, .9)
        self.assertEqual(self.depths(middle, far, clipped, near), ["unknown","far","unknown","near"])
