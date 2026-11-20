"""Sample a local video into the PaddleOCR JSON contract used by replay_signs."""

import argparse
import json
from pathlib import Path
from time import perf_counter

from .schemas import number


def sample_video(video, step, models):
    import cv2
    from paddleocr import PaddleOCR

    capture = cv2.VideoCapture(str(video))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        if not capture.isOpened() or not number(fps) or fps <= 0 or not number(count) or count <= 0:
            raise ValueError('cannot read video duration')
        detector = 'PP-OCRv5_mobile_det'
        recognizer = 'PP-OCRv5_mobile_rec'
        reader = PaddleOCR(text_detection_model_name=detector, text_recognition_model_name=recognizer,
                           text_detection_model_dir=str(models / detector) if models else None,
                           text_recognition_model_dir=str(models / recognizer) if models else None,
                           device='cpu', enable_mkldnn=False, cpu_threads=2, text_det_limit_type='max',
                           text_det_limit_side_len=960, use_doc_orientation_classify=False,
                           use_doc_unwarping=False, use_textline_orientation=False)
        stride = max(1, round(step * fps))
        frames, size = [], None
        start = perf_counter()
        for index in range(0, int(count), stride):
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, image = capture.read()
            if not ok:
                continue
            size = [image.shape[1], image.shape[0]]
            detections = []
            for result in reader.predict(image):
                for text, score, polygon in zip(result['rec_texts'], result['rec_scores'], result['rec_polys']):
                    detections.append({'text': text, 'confidence': float(score), 'polygon': polygon.tolist()})
            frames.append({'time_seconds': round(index / fps, 6), 'detections': detections})
        return {'engine': 'PaddleOCR PP-OCRv5 mobile', 'image_size': size, 'video': video.name,
                'sampled_frames': len(frames), 'elapsed_seconds': round(perf_counter() - start, 4), 'frames': frames}
    finally:
        capture.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--step', type=float, default=1.0)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--models', type=Path, help='Directory containing the two PP-OCRv5 mobile models')
    args = parser.parse_args()
    if not number(args.step) or args.step <= 0 or args.video.resolve() == args.out.resolve():
        parser.error('step must be positive and output must differ from video')
    try:
        data = sample_video(args.video, args.step, args.models)
        args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
