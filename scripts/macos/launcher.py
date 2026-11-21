"""macOS launcher for the VisionAssist web server and camera worker."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".visionassist"


def fingerprint(pid):
    proc = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart="],
                          capture_output=True, text=True)
    return proc.stdout.strip()


def stop_owned(records):
    for rec in reversed(records):
        pid = rec["pid"]
        if not rec["started"] or fingerprint(pid) != rec["started"]:
            continue
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGTERM)
            for _ in range(30):
                time.sleep(.1)
                if fingerprint(pid) != rec["started"]:
                    break
            else:
                os.killpg(pid, signal.SIGKILL)


def start(command, log, repo, env):
    with log.open("wb") as output:
        proc = subprocess.Popen(command, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    return proc, {"pid": proc.pid, "started": fingerprint(proc.pid)}


def wait_for(probe, proc, log, seconds):
    deadline = time.monotonic() + seconds
    while proc.poll() is None and time.monotonic() < deadline:
        if probe():
            return
        time.sleep(.3)
    raise RuntimeError(f"Service failed to become ready. See {log}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.getenv("VISIONASSIST_PORT", "8775")))
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--cv-device", default="auto")
    parser.add_argument("--cv-cpu-threads", type=int, default=4)
    parser.add_argument("--no-road-alerts", action="store_true")
    for name in ("cv-python", "agent-python", "models", "rtc-low-config", "stereo-config",
                 "certificate", "private-key", "dashboard-host", "cv-ca"):
        parser.add_argument("--" + name)
    a = parser.parse_args()
    if not 1024 <= a.port <= 65535 or not 1 <= a.cv_cpu_threads <= 32:
        parser.error("Invalid port or CPU thread count")
    STATE.mkdir(exist_ok=True)
    with (STATE / f"mac-{a.port}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        launch(a)


def launch(a):
    records_file = STATE / f"mac-{a.port}.json"
    saved = json.loads(records_file.read_text()) if records_file.exists() else {}
    records = saved.get("processes", [])
    if a.stop:
        stop_owned(records)
        records_file.unlink(missing_ok=True)
        print("VisionAssist stopped.")
        return
    if records and all(rec["started"] and fingerprint(rec["pid"]) == rec["started"] for rec in records):
        show(saved["url"], a.no_open)
        return
    stop_owned(records)
    records_file.unlink(missing_ok=True)
    if bool(a.certificate) != bool(a.private_key) or (a.dashboard_host and not a.certificate):
        raise ValueError("HTTPS requires both --certificate and --private-key")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", a.port))
    env = os.environ.copy()
    repo = Path(env.get("VISIONASSIST_REPO", ROOT)).resolve()
    def setting(arg, key, default):
        value = Path(arg or env.get(key) or default).expanduser().absolute()
        if not value.exists():
            raise ValueError(f"Missing {key}: {value}")
        env[key] = str(value)
        return str(value)
    cv = setting(a.cv_python, "VISIONASSIST_CV_PYTHON", repo/"cv/.venv/bin/python")
    # Preserve virtual environment executable paths (their symlink target is the base Python).
    setting(a.agent_python, "VISIONASSIST_PYTHON", repo/"llm/.venv/bin/python")
    setting(a.models, "VISIONASSIST_MODELS", repo/"llm/models")
    env.setdefault("VISIONASSIST_RTC_PYTHON", cv)
    env.setdefault("VISIONASSIST_DB", str(STATE/"memory.sqlite"))
    env.update(VISIONASSIST_PORT=str(a.port), YOLO_CONFIG_DIR=str(STATE/"ultralytics"))
    weights = Path(env.get("VISIONASSIST_WEIGHTS", repo/"cv/models/yolo11n.pt"))
    web = [shutil.which("node") or "node", "web/server.cjs"]
    base = f"http://127.0.0.1:{a.port}"
    url = f"http://localhost:{a.port}"
    tls = None
    if a.certificate:
        host = a.dashboard_host or "localhost"
        env["VISIONASSIST_DASHBOARD_HOST"] = host
        web.extend(str(Path(f).resolve(strict=True)) for f in (a.certificate, a.private_key))
        url = base = f"https://{host}:{a.port}"
        tls = ssl.create_default_context(cafile=a.cv_ca)
        if a.cv_ca:
            env["REQUESTS_CA_BUNDLE"] = str(Path(a.cv_ca).resolve())
    worker = [cv, "-u", "cv/live_camera.py", "--weights", str(weights.resolve(strict=True)),
              "--server", base, "--device", a.cv_device, "--cpu-threads", str(a.cv_cpu_threads)]
    road_model = repo/"cv/models/road-segformer-b0.onnx"
    if road_model.exists() and not a.no_road_alerts:
        worker.append("--road-alerts")
    for flag, file in [("--rtc-low-config", a.rtc_low_config), ("--stereo-config", a.stereo_config)]:
        if file:
            worker.extend([flag, str(Path(file).resolve(strict=True))])
    if not (repo/"web/.next/BUILD_ID").is_file():
        raise ValueError("Build the production web app first: cd web && npm ci && npm run build")
    def ready(endpoint, field, context=None):
        try:
            with urlopen(endpoint, timeout=2, context=context) as response:
                return field in json.load(response)
        except (OSError, ValueError):
            return False
    ollama_url = "http://127.0.0.1:11434/api/version"
    if not ready(ollama_url, "version"):
        log = STATE/"mac-ollama.log"
        proc, _ = start(["ollama", "serve"], log, repo, dict(env, OLLAMA_NO_CLOUD="1"))
        wait_for(lambda: ready(ollama_url, "version"), proc, log, 25)
    owned = []
    try:
        log = STATE/f"mac-web-{a.port}.log"
        proc, rec = start(web, log, repo, env)
        owned.append(rec)
        wait_for(lambda: ready(base+"/api/cv/sources", "sources", tls), proc, log, 45)
        log = STATE/f"mac-cv-{a.port}.log"
        proc, rec = start(worker, log, repo, env)
        owned.append(rec)
        wait_for(lambda: b"YOLO loaded" in log.read_bytes(), proc, log, 90)
        tmp = records_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"url": url, "processes": owned}))
        tmp.replace(records_file)
    except BaseException:
        stop_owned(owned)
        raise
    show(url, a.no_open)


def show(url, no_open):
    print(f"Assistant: {url}/#assist\nDashboard: {url}/#monitor\nCamera: {url}/camera")
    if not no_open:
        subprocess.run(["/usr/bin/open", url+"/#assist"], check=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        sys.exit(str(error))
