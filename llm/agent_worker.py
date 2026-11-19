"""Local speech and image feature extraction for VisionAssist."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import wave

# The Agent worker is launched as a script from any working directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cv.item_features import item_features, unit

MODELS = Path(os.environ.get("VISIONASSIST_MODELS", Path(__file__).parent / "models"))


def transcribe(payload):
    from faster_whisper import WhisperModel

    audio = io.BytesIO(base64.b64decode(payload["audio"], validate=True))
    provisioned = next((MODELS / name for name in ("whisper-small", "whisper-base")
                        if (MODELS / name / "model.bin").is_file()), "base")
    model = WhisperModel(
        os.environ.get("VISIONASSIST_STT_MODEL", str(provisioned)),
        device="cpu",
        compute_type="int8",
        local_files_only=True,
    )
    segments, info = model.transcribe(
        audio, language=payload.get("language"), beam_size=3,
        condition_on_previous_text=False, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 250},
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    if info.language == "zh" and text:
        from opencc import OpenCC

        text = OpenCC("t2s").convert(text)
    return {"text": text}


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


def synthesize(payload):
    from piper import PiperVoice

    voice_path = {
        "zh": "zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
        "en": "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    }[payload["language"]]
    voice = PiperVoice.load(MODELS / "piper" / voice_path)
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


def main(mode, payload):
    if mode == "stt":
        return transcribe(payload)
    if mode == "tts":
        return synthesize(payload)
    if mode == "docx":
        return export_conversation(payload)

    import cv2
    import numpy as np

    image = cv2.imdecode(
        np.frombuffer(base64.b64decode(payload["image"], validate=True), dtype=np.uint8),
        cv2.IMREAD_COLOR,
    )
    if image is None or not image.size or image.shape[0] * image.shape[1] > 4_000_000:
        raise ValueError("Invalid image")
    features = face_features(image) if mode == "face" else item_features(image, payload["boxes"])
    return {"features": features}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], json.load(sys.stdin)), ensure_ascii=False))
