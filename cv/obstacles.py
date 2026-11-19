"""Flag detections that overlap the camera's presumed forward path."""

PATH_LEFT = 0.35
PATH_RIGHT = 0.65
PATH_TOP = 0.60
MIN_PATH_OVERLAP = 0.25


def is_obstacle_candidate(bbox):
    """Check a normalized xyxy box against the lower-center image region.

    The lower edge is a proxy for where an object meets the walking surface.
    The overlap threshold ignores boxes that only graze the corridor.
    """
    x1, _, x2, y2 = bbox
    overlap = min(x2, PATH_RIGHT) - max(x1, PATH_LEFT)
    narrower_width = min(x2 - x1, PATH_RIGHT - PATH_LEFT)
    return y2 >= PATH_TOP and overlap >= MIN_PATH_OVERLAP * narrower_width
