"""Score confirmed-sign events against independently annotated intervals."""

import argparse
import csv
import json
from pathlib import Path
from statistics import median

from .schemas import Box, number, polygon_box
from .text_normalization import normalize_text


def parse_box(values):
    if not isinstance(values, list) or len(values) != 4:
        raise ValueError('expected [x1,y1,x2,y2] or a four-corner polygon')
    if isinstance(values[0], list):
        return polygon_box(values)
    if not all(map(number, values)) or not (0 <= values[0] < values[2] and 0 <= values[1] < values[3]):
        raise ValueError('invalid evaluation bounding box')
    return Box(*values)


def load_labels(path, clip_id):
    labels = []
    with path.open(newline='', encoding='utf-8-sig') as file:
        for row in csv.DictReader(file):
            if row['clip_id'] != clip_id:
                continue
            start, end = float(row['interval_start_s']), float(row['interval_end_s'])
            if not number(start) or not number(end) or not 0 <= start <= end or not row['sign_id'] or not row['exact_text'].strip():
                raise ValueError('invalid ground-truth row')
            polygon = row.get('bbox_or_polygon', '').strip()
            labels.append((row, start, end, parse_box(json.loads(polygon)) if polygon else None))
    if not labels:
        raise ValueError(f'no labels for {clip_id}')
    return labels


def evaluate(report, labels):
    match_indices, delays = set(), []
    duplicates = false_confirmations = ambiguous = directions_correct = directions_wrong = 0
    direction_labels = sum(bool(row.get('direction')) for row, *_ in labels)
    events = report['events']
    for event in (e for e in events if e['status'] == 'confirmed'):
        t = event['timestamp_seconds']
        text = normalize_text(' '.join(line['text'] for line in event['lines']))[0]
        box = parse_box(event['bbox_pixels'])
        candidates = [i for i, (row, start, end, labeled_box) in enumerate(labels)
                      if start <= t <= end and normalize_text(row['exact_text'])[0] == text
                      and (labeled_box is None or box.iou(labeled_box) >= 0.3)]
        if len(candidates) != 1:
            ambiguous += len(candidates) > 1
            false_confirmations += 1
            continue
        index = candidates[0]
        if index in match_indices:
            duplicates += 1
            continue
        match_indices.add(index)
        row, start, *_ = labels[index]
        delays.append(t - start)
        if row.get('direction'):
            relation = event['spatial_relation']
            if relation.get('direction') == row['direction'] and normalize_text(relation.get('destination', ''))[0] == normalize_text(row.get('destination', ''))[0]:
                directions_correct += 1
            elif relation.get('direction'):
                directions_wrong += 1
    true = len(match_indices)
    total = true + false_confirmations + duplicates
    return {'labels': len(labels), 'matched_signs': true, 'false_confirmations': false_confirmations,
            'duplicate_confirmations': duplicates, 'ambiguous_matches': ambiguous,
            'precision': true / total if total else None, 'recall': true / len(labels),
            'median_confirmation_delay_s': median(delays) if delays else None,
            'uncertain_events': sum(e['status'] == 'uncertain' for e in events),
            'direction_labels': direction_labels, 'direction_pairs_correct': directions_correct,
            'direction_pairs_wrong': directions_wrong, 'direction_unresolved': direction_labels - directions_correct - directions_wrong}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--labels', type=Path, required=True)
    parser.add_argument('--clip-id', required=True)
    args = parser.parse_args()
    try:
        labels = load_labels(args.labels, args.clip_id)
        report = json.loads(args.report.read_text(encoding='utf-8-sig'))
        print(json.dumps(evaluate(report, labels), indent=2, allow_nan=False))
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
