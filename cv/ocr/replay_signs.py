"""Replay saved PaddleOCR detections without loading a model."""

import argparse
import json
from pathlib import Path
from time import perf_counter

from .schemas import number
from .temporal_signs import Settings, TemporalSignFilter
from .text_normalization import DEFAULT_SHORT_SIGNS, normalize_text


def replay(data, size=None, camera_id='A', settings=None):
    if not isinstance(data, dict) or not isinstance(data.get('frames'), list):
        raise ValueError('expected an object containing a frames array')
    size = size if size is not None else data.get('image_size')
    if size is not None and (not isinstance(size, (list, tuple)) or len(size) != 2
                             or not all(number(v) and v > 0 for v in size)):
        raise ValueError('image_size must be [width, height] with positive values')
    if size is not None:
        size = tuple(size)
    filter_ = TemporalSignFilter(settings)
    events, frames = [], []
    start = perf_counter()
    for frame in data['frames']:
        metadata = frame if isinstance(frame, dict) else {}
        camera = metadata.get('camera_id', camera_id)
        stream = metadata.get('stream_id')
        if not isinstance(camera, str) or not camera or (stream is not None and not isinstance(stream, str)):
            frames.append({'status': 'invalid_source'})
            continue
        new_events, diagnostics = filter_.update(frame, camera, stream, size)
        events.extend(new_events)
        frames.append(diagnostics)
    return {'image_size': size, 'frames_processed': sum(f['status'] == 'processed' for f in frames),
            'elapsed_seconds': round(perf_counter() - start, 6), 'events': events, 'frames': frames}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-json', required=True, type=Path)
    parser.add_argument('--output-json', required=True, type=Path)
    parser.add_argument('--image-size', nargs=2, type=int, metavar=('WIDTH', 'HEIGHT'))
    parser.add_argument('--camera-id', default='A')
    parser.add_argument('--legacy-gxx', action='store_true', help='Replay the known Gxx door signs only, with legacy correction')
    parser.add_argument('--short-sign', action='append', default=[], help='Add an exact short-sign label')
    parser.add_argument('--window-seconds', type=float, default=4.0)
    parser.add_argument('--min-support-frames', type=int, default=2)
    parser.add_argument('--min-ocr-confidence', type=float, default=0.6)
    parser.add_argument('--min-confidence', type=float, default=0.75)
    parser.add_argument('--min-match-similarity', type=float, default=0.88)
    parser.add_argument('--track-cooldown-seconds', type=float, default=10.0)
    args = parser.parse_args()
    if args.input_json.resolve() == args.output_json.resolve():
        parser.error('output must differ from input')
    try:
        settings = Settings(window_seconds=args.window_seconds, min_support_frames=args.min_support_frames,
                            min_ocr_confidence=args.min_ocr_confidence, min_confidence=args.min_confidence,
                            min_match_similarity=args.min_match_similarity, track_cooldown_seconds=args.track_cooldown_seconds,
                            safety_support_frames=max(3, args.min_support_frames + 1),
                            safety_confidence=max(0.85, args.min_confidence),
                            short_signs=DEFAULT_SHORT_SIGNS | {normalize_text(label)[0] for label in args.short_sign},
                            legacy_gxx=args.legacy_gxx)
        data = json.loads(args.input_json.read_text(encoding='utf-8-sig'))
        report = replay(data, args.image_size, args.camera_id, settings)
        args.output_json.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
