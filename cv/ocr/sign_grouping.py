"""Group aligned lines without inferring arrows or pairing across columns."""

from dataclasses import dataclass
import re

from .text_normalization import classify, direction_of, normalize_text


DESTINATION = re.compile(r"\b(?:restrooms?|toilets?|bathrooms?|library|cafeteria|reception|lobby|rooms?|elevators?|stairs?|exits?|office|entrance)\b|洗手间|洗手間|图书馆|圖書館|出口|入口|电梯|電梯")


@dataclass(frozen=True)
class SignGroup:
    lines: tuple
    relation: dict | None = None


def alignment(upper, lower):
    gap = lower.top - upper.bottom
    height = max(upper.height, lower.height)
    overlap = min(upper.right, lower.right) - max(upper.left, lower.left)
    if not (-0.2 * height <= gap <= 1.1 * height and min(upper.height, lower.height) >= 0.5 * height):
        return None
    smaller = min(upper.width, lower.width)
    if overlap < 0.78 * smaller or abs(upper.center[0] - lower.center[0]) > 0.45 * smaller:
        return None
    return min(1, overlap / smaller) / (1 + max(0, gap) / height)


def group_signs(tracks, short_signs):
    ordered = sorted(tracks, key=lambda t: (t.observation.box.center[1], t.observation.box.left, t.id))
    keys = {t.id: normalize_text(t.observation.text)[0] for t in ordered}
    kinds = {key: classify(text, short_signs) for key, text in keys.items()}
    directions = {key: direction_of(text) for key, text in keys.items()}
    parents, children = {}, {}
    for index, upper in enumerate(ordered):
        for lower in ordered[index + 1:]:
            score = alignment(upper.observation.box, lower.observation.box)
            if score is None:
                continue
            children.setdefault(upper.id, []).append((lower.id, score))
            parents.setdefault(lower.id, []).append((upper.id, score))

    # Only a mutually unique alignment is used. Ambiguous lines remain visible separately.
    links = {top: below[0] for top, below in children.items()
             if len(below) == 1 and len(parents[below[0][0]]) == 1}
    by_id = {track.id: track for track in ordered}
    linked = set()
    groups = []
    for top, (bottom, score) in links.items():
        if not directions[bottom] or directions[top] or kinds[top] == 'room_number' or top in linked:
            continue
        # A complete destination line above a directional instruction. Do not treat a fragment as a destination.
        if not DESTINATION.search(keys[top]) or len(parents.get(top, [])) > 1 or children.get(bottom):
            continue
        destination = normalize_text(by_id[top].observation.text)[1]
        groups.append(SignGroup((by_id[top], by_id[bottom]), {
            'relationship': 'aligned', 'destination': destination, 'direction': directions[bottom], 'confidence': round(score, 3)
        }))
        linked.update((top, bottom))

    # Preserve full labels and directions as separate regions. Join only notice/unknown lines in reading order.
    for track in ordered:
        if track.id in linked:
            continue
        lines = [track]
        linked.add(track.id)
        tail = track.id
        while tail in links and kinds[tail] in ('unknown', 'long_text'):
            following = links[tail][0]
            if following in linked or kinds[following] not in ('unknown', 'long_text'):
                break
            lines.append(by_id[following])
            linked.add(following)
            tail = following
        groups.append(SignGroup(tuple(lines)))
    return sorted(groups, key=lambda g: (g.lines[0].observation.box.top, g.lines[0].observation.box.left))
