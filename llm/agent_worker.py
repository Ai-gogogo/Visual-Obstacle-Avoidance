"""Local speech and image feature extraction for VisionAssist."""
import base64
from contextlib import redirect_stdout
from functools import lru_cache
import io
import json
import os
from pathlib import Path
import sys
import traceback
import wave

# The Agent worker is launched as a script from any working directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cv.item_features import item_features, unit

MODELS = Path(os.environ.get("VISIONASSIST_MODELS", Path(__file__).parent / "models"))


@lru_cache(maxsize=1)
def whisper_model():
    from faster_whisper import WhisperModel

    provisioned = next((MODELS / name for name in ("whisper-small", "whisper-base")
                        if (MODELS / name / "model.bin").is_file()), "base")
    return WhisperModel(
        os.environ.get("VISIONASSIST_STT_MODEL", str(provisioned)),
        device="cpu",
        compute_type="int8",
        local_files_only=True,
    )


def transcribe(payload):
    audio = io.BytesIO(base64.b64decode(payload["audio"], validate=True))
    segments, info = whisper_model().transcribe(
        audio, language=payload.get("language"), beam_size=3,
        condition_on_previous_text=False, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 250},
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    if info.language == "zh" and text:
        from opencc import OpenCC

        text = OpenCC("t2s").convert(text)
    return {"text": text}


WAKE_MODELS = {
    "zh": ("vosk-model-small-cn-0.22", ("你好 视觉 助手",)),
    "en": ("vosk-model-small-en-us-0.15", ("hey vision assist",)),
}
STOP_PHRASES = {
    "zh": ("停止 播放", "停止 播报", "停止 朗读"),
    "en": ("stop playback", "stop reading"),
}
CANCEL_PHRASES = {
    "zh": ("取消 请求", "停止 生成"),
    "en": ("cancel request", "stop generating"),
}


@lru_cache(maxsize=2)
def wake_model(language):
    from vosk import Model, SetLogLevel

    SetLogLevel(-1)
    return Model(str(MODELS / WAKE_MODELS[language][0]))


def detect_wake(payload):
    from vosk import KaldiRecognizer

    language = payload["language"]
    purpose = payload.get("purpose")
    stopping = purpose in ("stop", "cancel")
    phrases = (STOP_PHRASES if purpose == "stop" else CANCEL_PHRASES)[language] if stopping else WAKE_MODELS[language][1]
    recording = io.BytesIO(base64.b64decode(payload["audio"], validate=True))
    with wave.open(recording, "rb") as audio:
        rate = audio.getframerate()
        if (audio.getnchannels() != 1 or audio.getsampwidth() != 2 or
                not 8000 <= rate <= 48000 or audio.getnframes() > rate * 9):
            raise ValueError("Invalid wake recording")
        pcm = audio.readframes(audio.getnframes())
    recognizer = KaldiRecognizer(wake_model(language), rate, json.dumps([*phrases, "[unk]"], ensure_ascii=False))
    recognizer.AcceptWaveform(pcm)
    heard = json.loads(recognizer.FinalResult()).get("text", "")
    matched = any(heard == phrase or (not stopping and heard.startswith(phrase + " ")) for phrase in phrases)
    return {"matched": "yes" if matched else "no"}


def export_conversation(payload):
    from docx import Document
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    document = Document()
    for name, size in (("Title", 22), ("Normal", 11)):
        style = document.styles[name]
        style.font.name = "Arial"
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    title_format = document.styles["Title"].element.get_or_add_pPr()
    border = title_format.find(qn("w:pBdr"))
    if border is not None:
        title_format.remove(border)
    document.add_paragraph("VisionAssist 对话记录", "Title")
    for message in payload["messages"]:
        speaker = document.add_paragraph()
        speaker.paragraph_format.keep_with_next = True
        speaker.paragraph_format.space_before = Pt(6)
        speaker.add_run("用户" if message["role"] == "user" else "VisionAssist").bold = True
        document.add_paragraph(message["text"])
    result = io.BytesIO()
    document.save(result)
    return {"document": base64.b64encode(result.getvalue()).decode("ascii")}


@lru_cache(maxsize=2)
def speech_voice(language):
    from onnxruntime import InferenceSession, SessionOptions
    from piper import PiperConfig, PiperVoice

    voice_path = {
        "zh": "zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
        "en": "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    }[language]
    model_path = MODELS / "piper" / voice_path
    with model_path.with_suffix(".onnx.json").open(encoding="utf-8") as config_file:
        config = PiperConfig.from_dict(json.load(config_file))
    # Limit the speech worker's CPU pool so it can run alongside CV.
    options = SessionOptions()
    options.intra_op_num_threads = 2
    session = InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
    return PiperVoice(session=session, config=config)


def synthesize(payload):
    voice = speech_voice(payload["language"])
    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        voice.synthesize_wav(payload["text"], wav)
    return {"audio": base64.b64encode(audio.getvalue()).decode("ascii")}


def face_features(image):
    import cv2

    height, width = image.shape[:2]
    detector = cv2.FaceDetectorYN.create(
        str(MODELS / "face_detection_yunet_2023mar.onnx"), "", (width, height)
    )
    detector.setScoreThreshold(0.90)
    _, faces = detector.detect(image)
    if faces is None:
        return []
    recognizer = cv2.FaceRecognizerSF.create(
        str(MODELS / "face_recognition_sface_2021dec.onnx"), ""
    )
    return [
        unit(recognizer.feature(recognizer.alignCrop(image, face)), "sface-2021dec")
        if min(face[2:4]) >= 50 else None
        for face in faces
    ]


class InvalidImage(ValueError):
    pass


def decode_image(payload, max_pixels=4_000_000):
    import cv2
    import numpy as np

    try:
        image = cv2.imdecode(
            np.frombuffer(base64.b64decode(payload["image"], validate=True), dtype=np.uint8),
            cv2.IMREAD_COLOR,
        )
    except (ValueError, cv2.error) as error:
        raise InvalidImage("Invalid image") from error
    if image is None or not image.size or image.shape[0] * image.shape[1] > max_pixels:
        raise InvalidImage("Invalid image")
    return image


def serve_ocr():
    reader = None
    for line in sys.stdin:
        try:
            with redirect_stdout(sys.stderr):
                image = decode_image(json.loads(line), max_pixels=3840 * 2160)
                if reader is None:
                    cache = Path(__file__).parent / ".visionassist" / "paddlex"
                    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(cache))
                    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
                    from paddleocr import PaddleOCR

                    detector = MODELS / "ocr" / "PP-OCRv5_mobile_det"
                    recognizer = MODELS / "ocr" / "PP-OCRv5_mobile_rec"
                    reader = PaddleOCR(
                        text_detection_model_name=detector.name,
                        text_detection_model_dir=str(detector) if (detector / "inference.pdiparams").is_file() else None,
                        text_recognition_model_name=recognizer.name,
                        text_recognition_model_dir=str(recognizer) if (recognizer / "inference.pdiparams").is_file() else None,
                        use_doc_orientation_classify=False,
                        use_doc_unwarping=False,
                        use_textline_orientation=False,
                        device="cpu",
                        enable_mkldnn=False,
                        cpu_threads=2,
                        text_det_limit_side_len=960,
                        text_det_limit_type="max",
                        text_rec_score_thresh=0.0,
                    )
                lines = []
                uncertain = False
                for result in reader.predict(image):
                    recognized = 0
                    for text, score in zip(result["rec_texts"], result["rec_scores"]):
                        if text.strip() and score >= 0.8:
                            lines.append(text.strip())
                            recognized += 1
                    uncertain |= recognized < max(len(result["dt_polys"]), len(result["rec_texts"]))
            print(json.dumps({"text": "\n".join(lines), "uncertain": uncertain}, ensure_ascii=False), flush=True)
        except InvalidImage:
            print('{"text":"","invalid_frame":true}', flush=True)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            print('{"error":"OCR inference failed"}', flush=True)
            return


def main(mode, payload):
    if mode == "stt":
        return transcribe(payload)
    if mode == "wake":
        return detect_wake(payload)
    if mode == "tts":
        return synthesize(payload)
    if mode == "docx":
        return export_conversation(payload)

    image = decode_image(payload)
    features = face_features(image) if mode == "face" else item_features(image, payload["boxes"])
    return {"features": features}


if __name__ == "__main__":
    mode = sys.argv[1]
    sessions = {"stt-session": transcribe, "tts-session": synthesize, "wake-session": detect_wake}
    if mode == "ocr":
        serve_ocr()
    elif mode in sessions:
        work = sessions[mode]
        for line in sys.stdin:
            try:
                result = work(json.loads(line))
            except Exception:
                result = {"error": True}
            print(json.dumps(result, ensure_ascii=False), flush=True)
    else:
        print(json.dumps(main(sys.argv[1], json.load(sys.stdin)), ensure_ascii=False))
