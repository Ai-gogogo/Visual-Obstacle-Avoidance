import unittest
import json
from pathlib import Path

from cv.ocr.evaluate_signs import evaluate, load_labels
from cv.ocr.replay_signs import replay
from cv.ocr.schemas import polygon_box
from cv.ocr.temporal_signs import Settings, TemporalSignFilter
from cv.ocr.text_normalization import classify, normalize_text, similarity


def detection(text, x=20, y=20, width=120, height=25, confidence=.97):
    return {'text': text, 'confidence': confidence,
            'polygon': [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]}


def frame(t, *observations, **metadata):
    return {'time_seconds': t, 'detections': list(observations), **metadata}


class TemporalSignsTest(unittest.TestCase):
    def test_text_and_geometry(self):
        self.assertEqual(normalize_text('  ＥＸＩＴ  ONLY!  '), ('exit only!', 'ＥＸＩＴ ONLY!'))
        self.assertEqual(classify('g17'), 'room_number')
        self.assertEqual(classify('turn right'), 'direction')
        self.assertEqual(classify('new label'), 'unknown')
        for a, b in [('turn left', 'turn right'), ('no change', 'change'), ('exit only', 'exit'),
                     ('staff only', 'aff nly'), ('g17', 'g18'), ('禁止入内的房间', '允许入内的房间')]:
            with self.subTest(a=a, b=b):
                self.assertEqual(similarity(a, b), 0)
        self.assertGreater(similarity('central library', 'centrl library'), 0.88)
        box = polygon_box([[20, 10], [10, 0], [10, 10], [20, 0]], (100, 100))
        self.assertEqual(box.normalized((100, 100)), [.1, 0, .2, .1])
        for polygon in ([[0, 0]] * 4, [[0, 0], [20, 0], [10, 1], [0, 20]],
                        [[0, 0], [20, 0], [20, float('nan')], [0, 20]]):
            with self.assertRaises(ValueError):
                polygon_box(polygon, (20, 20))

    def test_dedup_and_per_location_identity(self):
        report = replay({'image_size': [600, 240], 'frames': [frame(t, detection('BOOK DROP'),
                         detection('BOOK DROP', x=310), detection('BOOK DROP', x=21)) for t in range(15)]})
        events = report['events']
        self.assertEqual([e['timestamp_seconds'] for e in events], [1, 1])
        self.assertNotEqual(events[0]['track_id'], events[1]['track_id'])
        self.assertEqual(len(report['frames'][0]['regions']['started']), 2)
        self.assertTrue(all(e['support_frames'] == 2 for e in events))

    def test_conflicts_abstain_and_legacy_is_opt_in(self):
        for left, right in [('NO CHANGE', 'CHANGE'), ('EXIT ONLY', 'EXIT'), ('STAFF ONLY', 'AFF NLY')]:
            events = replay({'frames': [frame(0, detection(left)), frame(1, detection(right)),
                                         frame(2, detection(left))]})['events']
            self.assertEqual([e['status'] for e in events], ['uncertain'])
            self.assertEqual(events[0]['spatial_relation'], {'relationship': 'unknown'})
        data = {'frames': [frame(0, detection('G17')), frame(1, detection('G|17'))]}
        self.assertEqual(replay(data)['events'][0]['status'], 'uncertain')
        report = replay(data, settings=Settings(legacy_gxx=True))
        self.assertEqual(report['events'][0]['lines'][0]['text'], 'G17')
        self.assertEqual(report['frames'][1]['corrections'][0]['raw_text'], 'G|17')

    def test_track_crossing_and_occlusion(self):
        frames = [frame(t, detection('Alpha', x=20 + 25*t, width=55),
                        detection('Bravo', x=140 - 25*t, width=55)) for t in range(5)]
        frames.extend([frame(5), frame(6, detection('Alpha', x=170, width=55)),
                       frame(9, detection('Alpha', x=170, width=55)), frame(10, detection('Alpha', x=170, width=55))])
        report = replay({'frames': frames})
        def line_id(index, label):
            return next(g['line_track_ids'][0] for g in report['frames'][index]['groups'] if g['lines'] == (label,))
        self.assertEqual(line_id(0, 'Alpha'), line_id(4, 'Alpha'))
        self.assertEqual(line_id(0, 'Bravo'), line_id(4, 'Bravo'))
        self.assertIn(line_id(0, 'Alpha'), report['frames'][5]['regions']['occluded'])
        self.assertEqual(line_id(0, 'Alpha'), line_id(6, 'Alpha'))
        self.assertNotEqual(line_id(0, 'Alpha'), line_id(7, 'Alpha'))
        self.assertIn(line_id(0, 'Alpha'), report['frames'][7]['regions']['lost'])

    def test_directional_columns_and_ambiguity(self):
        signs = [detection("Men's Restroom", x=20), detection('Turn Left', x=38, y=50, width=84),
                 detection("Women's Restroom", x=230), detection('Turn Right', x=244, y=50, width=92)]
        report = replay({'frames': [frame(t, *signs) for t in range(3)]})
        self.assertFalse(any(e['timestamp_seconds'] < 2 for e in report['events']))
        self.assertEqual({(e['spatial_relation']['destination'], e['spatial_relation']['direction']) for e in report['events']},
                         {("Men's Restroom", 'left'), ("Women's Restroom", 'right')})
        ambiguous = [detection('Library', x=20), detection('Reception', x=26), detection('Turn Left', x=35, y=50)]
        report = replay({'frames': [frame(t, *ambiguous) for t in range(3)]})
        self.assertEqual(len(report['frames'][0]['groups']), 3)
        self.assertTrue(all(e['spatial_relation']['relationship'] == 'unknown' for e in report['events']))

    def test_bad_inputs_and_stream_isolation(self):
        filter_ = TemporalSignFilter()
        self.assertEqual(filter_.update(frame('oops'))[1]['status'], 'invalid_timestamp')
        self.assertEqual(filter_.update(frame(0, {'text': 'EXIT', 'confidence': .9}))[1]['skipped'][0]['index'], 0)
        self.assertEqual(filter_.update(frame(0))[1]['status'], 'non_increasing_timestamp')
        initial = filter_.update(frame(1, detection('Label')), camera_id='A', stream_id='one')[1]
        self.assertFalse(filter_.update(frame(1, detection('Label')), camera_id='B', stream_id='one')[0])
        reset = filter_.update(frame(0, detection('Label')), camera_id='A', stream_id='two')
        self.assertFalse(reset[0])
        self.assertEqual(reset[1]['regions']['lost'], initial['regions']['started'])
        self.assertNotEqual(initial['regions']['started'], reset[1]['regions']['started'])
        self.assertEqual(filter_.update(frame(1, detection('Label')), camera_id='A', stream_id='two')[0][0]['status'], 'confirmed')

    def test_example_report_scores_exact_signs_and_pairs(self):
        fixture = Path(__file__).parent
        report = replay(json.loads((fixture / 'example-signs.json').read_text(encoding='utf-8')))
        labels = load_labels(fixture / 'example-signs-labels.csv', 'synthetic')
        self.assertEqual([e['timestamp_seconds'] for e in report['events'] if e['lines'][0]['text'] == 'EXIT'], [2])
        scores = evaluate(report, labels)
        self.assertEqual(scores['matched_signs'], 5)
        self.assertEqual(scores['direction_pairs_correct'], 2)
        self.assertEqual(scores['median_confirmation_delay_s'], 2)
        report['events'].append(report['events'][0])
        self.assertEqual(evaluate(report, labels)['duplicate_confirmations'], 1)


if __name__ == '__main__':
    unittest.main()
