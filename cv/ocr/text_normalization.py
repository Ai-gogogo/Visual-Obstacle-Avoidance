"""Match visual text without rewriting the display text or losing negation."""

from difflib import SequenceMatcher
import re
import unicodedata


DEFAULT_SHORT_SIGNS = frozenset({'exit', 'exit only', 'entry', 'book drop', 'staff only', 'restroom'})
PROTECTED = frozenset({'left', 'right', 'exit', 'entry', 'no', 'not', 'only', 'never', 'without',
                       'closed', 'open', 'up', 'down', '禁止', '出口', '入口', '左', '右', '仅'})
DIRECTION = re.compile(r'(?:turn\s+)?(left|right)|(?:向|往)?([左右])(?:转|轉)?')
ROOM = re.compile(r'g[0-9]{2}')


def normalize_text(text):
    display = ' '.join(text.split())
    key = ' '.join(unicodedata.normalize('NFKC', display).casefold().split())
    return key, display


def direction_of(key):
    match = DIRECTION.fullmatch(key)
    return (match[1] or {'左': 'left', '右': 'right'}[match[2]]) if match else None


def classify(key, short_signs=DEFAULT_SHORT_SIGNS):
    if ROOM.fullmatch(key):
        return 'room_number'
    if direction_of(key):
        return 'direction'
    if key in short_signs:
        return 'short_sign'
    return 'long_text' if len(key.split()) >= 7 or len(key) >= 60 else 'unknown'


def similarity(left, right, minimum=0.88):
    if left == right:
        return 1.0
    left_words = re.findall(r'[^\W_]+', left)
    right_words = re.findall(r'[^\W_]+', right)
    if min(len(left), len(right)) < 8 or len(left_words) != len(right_words):
        return 0.0
    if classify(left) == 'room_number' or classify(right) == 'room_number':
        return 0.0
    if (set(left_words) & PROTECTED) != (set(right_words) & PROTECTED):
        return 0.0
    if any((term in left) != (term in right) for term in ('不', '禁止', '出口', '入口', '左', '右', '仅')):
        return 0.0
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    # Bound the actual edits as well as the ratio, and reject shortened or fragmentary readings.
    edits = sum(max(b - a, d - c) for op, a, b, c, d in matcher.get_opcodes() if op != 'equal')
    ratio = matcher.ratio()
    return ratio if ratio >= minimum and edits <= 2 else 0.0
