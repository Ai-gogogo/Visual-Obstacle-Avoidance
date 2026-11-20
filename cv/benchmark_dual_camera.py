"""Replay two phone-sized JPEG streams against an isolated server and the normal live CLI."""
import argparse
import csv
import io
import json
import math
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack
from importlib.metadata import version
from pathlib import Path

import requests
from PIL import Image
from ultralytics.utils import ASSETS

from live_camera import inference_options, resolve_device

ROOT = Path(__file__).resolve().parents[1]
WINDOW_SECONDS = 30
PERIOD = 0.22


def start(stack, command, **kwargs):
    proc = subprocess.Popen(command, cwd=ROOT, **kwargs)
    stack.callback(proc.wait, 10)
    stack.callback(proc.terminate)
    return proc


def measure(temp, args, device):
    with ExitStack() as stack:
        http = stack.enter_context(requests.Session())
        server = start(stack, ["node", "-e", """
          const s=require('./web/server.cjs').createServer({agent:{filename:':memory:'}});
          s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"""], stdout=subprocess.PIPE, text=True)
        stack.callback(server.stdout.close)
        base = "http://127.0.0.1:" + str(int(server.stdout.readline()))

        def request(method, path, **kwargs):
            response = http.request(method, base + path, timeout=5, **kwargs)
            response.raise_for_status()
            return response

        desk = {"Authorization": "Bearer " + request("POST", "/api/session").json()["token"]}
        request("GET", "/api/agent/alerts", headers=desk)
        streams = []
        for side, filename in [("A", "bus.jpg"), ("B", "zidane.jpg")]:
            code = request("POST", "/api/pair/" + side, headers=desk).json()["code"]
            phone = request("POST", "/api/join", json={"code": code}).json()["token"]
            with Image.open(ASSETS / filename) as image:
                image.thumbnail((640, 640))
                jpeg = io.BytesIO()
                image.save(jpeg, "JPEG", quality=70)
            streams.append(({"Authorization": "Bearer " + phone, "Content-Type": "image/jpeg"}, jpeg.getvalue()))

        log = temp / "worker.csv"
        command = [sys.executable, "cv/live_camera.py", "--dual-yolo", "--server", base, "--metrics", str(log),
                   "--device", device, "--imgsz", str(args.imgsz), "--cpu-threads", str(args.cpu_threads),
                   "--poll-ms", str(args.poll_ms)]
        if args.half:
            command.append("--half")
        worker = start(stack, command)

        def upload_pair():
            if worker.poll() is not None:
                raise RuntimeError("YOLO worker exited")
            for headers, data in streams:
                request("PUT", "/api/frame", headers=headers, data=data)

        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            upload_pair()
            if all(request("GET", "/api/preview/" + side, headers=desk).json()["objects"] for side in "AB"):
                break
            time.sleep(PERIOD)
        else:
            raise RuntimeError("Both cameras must produce detections before measurement")

        gpu_sampler = None
        gpu_log = temp / "gpu.csv"
        if device.startswith("cuda") and shutil.which("nvidia-smi"):
            out = stack.enter_context(gpu_log.open("w"))
            gpu_sampler = start(stack, ["nvidia-smi", "--query-gpu=index,utilization.gpu,memory.used",
                                        "--format=csv,noheader,nounits", "--loop-ms=500"],
                                stdout=out, stderr=subprocess.DEVNULL)

        begin_ms = time.time_ns() // 1_000_000
        begin = time.monotonic()
        uploads = 0
        while time.monotonic() - begin < WINDOW_SECONDS:
            upload_pair()
            uploads += 1
            next_tick = min(begin + uploads * PERIOD, begin + WINDOW_SECONDS)
            time.sleep(max(0, next_tick - time.monotonic()))
        gpu = {}
        if gpu_sampler:
            gpu_sampler.terminate()
            gpu_sampler.wait(5)
            with gpu_log.open() as src:
                for row in csv.reader(src, skipinitialspace=True):
                    if len(row) == 3 and all(value.isdecimal() for value in row):
                        index, utilization, memory = row
                        gpu.setdefault(index, []).append((int(utilization), int(memory)))
        time.sleep(0.5)  # Let acknowledgments reach the CSV before reading it.
        with log.open() as src:
            samples = []
            for row in csv.DictReader(src):
                accepted = int(row["accepted_ms"]) - begin_ms
                latency = int(row["latency_ms"])
                if 0 <= accepted - latency <= accepted < WINDOW_SECONDS * 1000:
                    samples.append((row["camera"], accepted, latency))
        return uploads, sorted(samples, key=lambda row: row[1]), gpu


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New directory for summary and frame timings")
    inference_options(parser)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Choose a new output directory")
    try:
        device = resolve_device(args.device)
    except ValueError as error:
        parser.error(str(error))
    with tempfile.TemporaryDirectory() as tmp:
        uploads, samples, gpu = measure(Path(tmp), args, device)
    summary = {"window_seconds": WINDOW_SECONDS, "upload_period_ms": round(PERIOD * 1000),
               "uploads_per_camera": uploads, "platform": platform.platform(), "device": device,
               "imgsz": args.imgsz, "fp16": args.half, "poll_ms": args.poll_ms,
               "cpu_threads_per_inference": args.cpu_threads if device == "cpu" else None,
               "model": "YOLO11n", "python": platform.python_version(),
               "ultralytics": version("ultralytics"), "torch": version("torch"), "cameras": {}}
    summary["gpu"] = {
        index: {"samples": len(rows),
                "utilization_median_percent": statistics.median(util for util, _ in rows),
                "memory_peak_mib": max(memory for _, memory in rows)}
        for index, rows in gpu.items()
    } or None
    for side in "AB":
        times = sorted(ms for camera, _, ms in samples if camera == side)
        if not times:
            raise RuntimeError(f"No accepted frames for camera {side} in the measurement window")
        summary["cameras"][side] = {"frames": len(times), "fps": round(len(times)/WINDOW_SECONDS, 2),
                                    "latency_median_ms": statistics.median(times),
                                    "latency_p95_ms": times[math.ceil(0.95 * len(times)) - 1]}
    args.output.mkdir(parents=True)
    with (args.output / "frames.csv").open("w", newline="") as out:
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(["camera", "accepted_since_start_ms", "latency_ms"])
        writer.writerows(samples)
    report = json.dumps(summary, indent=2)
    (args.output / "summary.json").write_text(report + "\n", encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
