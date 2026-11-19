"""Publish live Camera A detections to the local VisionAssist server."""
import argparse
import io
import sys
import time
from pathlib import Path

import requests
from PIL import Image, ImageOps

from detect_image import DEFAULT_WEIGHTS, detect


class CameraAWorker:
    def __init__(self, server, model, session):
        self.api = server.rstrip("/") + "/api/cv"
        self.model = model
        self.http = session
        self.etags = {}

    def poll(self):
        sources = self.http.get(self.api + "/sources", timeout=3)
        sources.raise_for_status()
        active = {s["source_id"] for s in sources.json()["sources"] if s["camera_id"] == "A"}
        for source in self.etags.keys() - active:
            del self.etags[source]
        for source in active:
            self.process_frame(source)

    def process_frame(self, source):
        params = {"source_id": source, "camera_id": "A"}
        headers = {"If-None-Match": self.etags[source]} if source in self.etags else {}
        frame = self.http.get(self.api + "/frame", params=params, headers=headers, timeout=3)
        if frame.status_code in (204, 304, 404):
            return
        frame.raise_for_status()
        # The phone may upload again between discovery, this GET and publication.
        # Only the ETag on these JPEG bytes identifies the image we will process.
        etag = frame.headers["ETag"]
        try:
            with Image.open(io.BytesIO(frame.content)) as jpeg:
                image = ImageOps.exif_transpose(jpeg).convert("RGB")
        except (OSError, Image.DecompressionBombError) as error:
            self.etags[source] = etag
            print(f"Skipping unreadable Camera A frame: {error}", file=sys.stderr)
            return

        objects = detect(self.model, image)
        result = self.http.post(self.api + "/detections", params=params, timeout=3,
                                json={"frame_id": etag.strip('"'), "objects": objects})
        if result.status_code not in (404, 409):
            result.raise_for_status()
        # Accepted or obsolete. A transient transport/server failure above leaves
        # this ETag eligible for retry if the same JPEG is still available.
        self.etags[source] = etag


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8765",
                        help="VisionAssist server URL on this computer")
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    args = parser.parse_args()
    if not args.weights.is_file():
        parser.error(f"Missing local weights: {args.weights}. See cv/README.md for setup.")

    from ultralytics import YOLO

    with requests.Session() as session:
        worker = CameraAWorker(args.server, YOLO(str(args.weights), task="detect"), session)
        print(f"YOLO loaded. Watching Camera A at {args.server}. Ctrl+C to stop.", flush=True)
        last_error = None
        try:
            while True:
                try:
                    worker.poll()
                    last_error = None
                except requests.RequestException as error:
                    message = str(error)
                    if message != last_error:
                        print(f"Camera A connection failed; retrying: {message}", file=sys.stderr)
                    last_error = message
                    time.sleep(1)
                    continue
                time.sleep(0.15)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
