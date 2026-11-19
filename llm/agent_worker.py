"""Local speech and image feature extraction for VisionAssist."""
import base64
import io
import json
import os
from pathlib import Path
import sys
import wave

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


def unit(vector, version):
    import numpy as np

    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    magnitude = np.linalg.norm(vector)
    if not magnitude or not np.isfinite(magnitude):
        return None
    return {"version": version, "vector": (vector / magnitude).tolist()}


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


def item_features(image, boxes):
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    features = []
    for x1, y1, x2, y2 in boxes:
        cropped = image[round(y1 * height):round(y2 * height), round(x1 * width):round(x2 * width)]
        if not cropped.size or min(cropped.shape[:2]) < 24:
            features.append(None)
            continue
        hsv = cv2.cvtColor(cv2.resize(cropped, (48, 48)), cv2.COLOR_BGR2HSV)
        cells = [hsv, hsv[:24, :24], hsv[:24, 24:], hsv[24:, :24], hsv[24:, 24:]]
        histograms = [
            np.sqrt(cv2.calcHist([cell], [0, 1, 2], None, [12, 3, 3],
                                [0, 180, 0, 256, 0, 256]).reshape(-1) / (cell.size / 3))
            for cell in cells
        ]
        features.append(unit(np.concatenate(histograms), "spatial-hsv-v1"))
    return features


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
