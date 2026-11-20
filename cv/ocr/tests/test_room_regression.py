import unittest
from cv.ocr.studyroom_temporal import candidate_room, RoomTemporalFilter

class TestRoomOCR(unittest.TestCase):
    def test_examples(self):
        examples={'G|01':'G01','Gl01':'G01','6101':'G01','G|02':'G02','Gi02':'G02',
                  'G103':'G03','G|03':'G03','G/04':'G04','Gj04':'G04','G|04':'G04', 'G01':'G01'}
        for raw, expected in examples.items():
            with self.subTest(raw=raw):
                self.assertEqual(candidate_room(raw)[0],expected)
    def test_reject_incomplete(self):
        for raw in ('G/0','G/O:','03','THUU','', 'Room ABC'):
            self.assertIsNone(candidate_room(raw))
    def test_temporal_votes_and_dedup(self):
        f=RoomTemporalFilter(window=4,min_votes=2,cooldown=10)
        self.assertEqual(f.update([{'text':'G|01','confidence':.92}],3),[])
        self.assertEqual([x['room'] for x in f.update([{'text':'Gl01','confidence':.89}],4)],['G01'])
        self.assertEqual(f.update([{'text':'G|01','confidence':.99}],5),[])
        self.assertEqual([x['room'] for x in f.update([{'text':'G|02','confidence':.89}],12)],[])
        self.assertEqual([x['room'] for x in f.update([{'text':'Gi02','confidence':.89}],13)],['G02'])

if __name__=='__main__': unittest.main()
