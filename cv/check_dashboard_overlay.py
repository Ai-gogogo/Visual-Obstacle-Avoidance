"""Exercise the dual-camera dashboard in Chromium with actual YOLO and HTTP pairing."""
import argparse
import base64
import io
import subprocess
import time

import cv2
import numpy as np
from pathlib import Path

import requests
from PIL import Image
from playwright.sync_api import expect, sync_playwright
from ultralytics import YOLO
from ultralytics.utils import ASSETS

from detect_image import DEFAULT_WEIGHTS
from live_camera import CameraWorker
from stereo_depth import StereoDepth
from test_stereo_depth import configuration


def pair_phone(page, host, side):
    page.get_by_role("button", name="Pair a phone").click()
    page.get_by_role("button", name=f"Code for Camera {side}").click()
    code = page.locator(".pair-code").inner_text().replace(" ", "")
    response = requests.post(host + "/api/join", json={"code": code}, timeout=3)
    response.raise_for_status()
    page.get_by_role("button", name="Close pairing dialog").click()
    return {"Authorization": "Bearer " + response.json()["token"], "Content-Type": "image/jpeg"}


def check_dual_views(page, host, desktop, model, screenshots):
    headers = {side: pair_phone(page, host, side) for side in "AB"}
    config = configuration()
    # Project the bundled photograph as a flat card 2 m away (240 px * 0.1 m / 2 m).
    with Image.open(ASSETS / "bus.jpg") as photo:
        card = photo.convert("RGB")
        card.thumbnail((320, 192))
    left = np.full((192, 320, 3), 160, np.uint8)
    x = (320-card.width) // 2
    left[:, x:x+card.width] = cv2.cvtColor(np.asarray(card), cv2.COLOR_RGB2BGR)
    right = cv2.warpAffine(left, np.float32([[1, 0, -12], [0, 1, 0]]), (320, 192))
    with requests.Session() as http:
        worker = CameraWorker(host, model, http, "A", stereo=StereoDepth(config))
        def upload(side, image, stamp):
            timing = {"X-Sample-Ms": str(stamp), "X-Clock-Error-Ms": "2"}
            http.put(host + "/api/frame", headers={**headers[side], **timing},
                     data=cv2.imencode(".jpg", image)[1].tobytes(), timeout=3).raise_for_status()

        with page.expect_response(lambda r: "/api/preview/A" in r.url and '"meters":true' in r.request.headers.get("x-depth-options","")):
            page.locator("#depth-meters").check()
        stamp = int(time.time() * 1000)
        upload("B", right, stamp)
        upload("A", left, stamp)
        worker.poll()
        snapshot = http.get(host + "/api/preview/A", headers=desktop, timeout=3).json()
        assert snapshot["stereo_status"] == "ready"
        depth_map = page.locator("#stereo-map")
        camera = page.locator('[data-camera="A"] canvas')
        for canvas in [camera, depth_map]:
            expect(canvas).to_have_attribute("data-frame-id", snapshot["frame_id"])
            expect(canvas).to_be_visible()
        expect(page.locator('[data-camera="B"]')).to_be_hidden()
        expect(page.locator('#depth-scale')).to_contain_text('0.25 m')
        bus = next(o for o in snapshot["objects"] if o["label"] == "bus")
        assert abs(bus["depth_m"] - 2) < 0.08
        bus_row = page.locator("#detection-rows tr").filter(has_text="bus")
        expect(bus_row).to_contain_text(f'{bus["depth_m"]:.2f} m')
        if screenshots:
            page.locator(".feed-grid").screenshot(path=str(screenshots / "stereo.png"))
        http.delete(host + "/api/frame", headers=headers["B"], timeout=3).raise_for_status()
        expect(depth_map).to_be_hidden()
        expect(bus_row).to_contain_text("—")
        expect(camera).to_have_attribute("data-frame-id", snapshot["frame_id"])
        upload("A", left, int(time.time() * 1000))
        worker.poll()
        updated = http.get(host + "/api/preview/A", headers=desktop, timeout=3).json()
        assert updated["frame_id"] != snapshot["frame_id"]
        expect(camera).to_have_attribute("data-frame-id", updated["frame_id"])
        expect(page.locator("#stereo-caption")).to_contain_text("waiting for two")


def exercise(page, host, model, screenshots):
    with page.expect_response(lambda r: r.url == host + "/api/session") as session:
        page.goto(host)
    desktop = {"Authorization": "Bearer " + session.value.json()["token"]}
    headers = pair_phone(page, host, "A")

    feed = page.locator('[data-camera="A"]')
    canvas = feed.locator("canvas")
    with Image.open(ASSETS / "bus.jpg") as photo:
        person = photo.crop((44, 390, 244, 907))
    person.thumbnail((122, 272))
    with requests.Session() as http:
        worker = CameraWorker(host, model, http, 'A')
        for state, left in [("left", 24), ("continuous", 48), ("right", 500), ("empty", None), ("reappeared", 24)]:
            image = Image.new("RGB", (640, 360), "#dedede")
            if left is not None:
                image.paste(person, (left, 44))
            jpeg = io.BytesIO()
            image.save(jpeg, "JPEG", quality=85)
            http.put(host + "/api/frame", headers=headers, data=jpeg.getvalue(), timeout=3).raise_for_status()
            worker.poll()
            snapshot = http.get(host + "/api/preview/A", headers=desktop, timeout=3).json()
            assert base64.b64decode(snapshot["jpeg"]) == jpeg.getvalue()
            expect(canvas).to_have_attribute("data-frame-id", snapshot["frame_id"])
            expect(canvas).to_be_visible()
            rows = page.locator("#detection-rows tr")
            expect(rows).to_have_count(len(snapshot["objects"]))
            png = canvas.evaluate("c => c.toDataURL('image/png').split(',')[1]")
            with Image.open(io.BytesIO(base64.b64decode(png))) as rendered:
                if left is None:
                    assert snapshot["objects"] == []
                    assert rendered.convert("RGB").getextrema() == ((222, 222),) * 3, "Old graphics on blank frame"
                    expect(page.locator("#empty-detections")).to_be_visible()
                else:
                    person_box = next(o for o in snapshot["objects"] if o["label"] == "person")
                    position = "right" if state == "right" else "left"
                    track_id = person_box["track_id"]
                    expect(rows.filter(has_text="person").first).to_contain_text("#" + track_id)
                    if state == "left":
                        initial_id = track_id
                    elif state == "continuous":
                        assert track_id == initial_id
                    assert person_box["position"] == position
                    expect(rows.filter(has_text="person").first).to_contain_text(position)
                    x1, y1, _, y2 = person_box["bbox"]
                    x, y = round(x1 * image.width), round((y1 + y2) * image.height / 2)
                    assert rendered.getpixel((x, y))[:3] == (140, 233, 255), "Missing box edge"
                    if state == "right":
                        assert rendered.getpixel(previous_edge)[:3] == (222, 222, 222), "Old box survived"
                    previous_edge = (x, y)
            if screenshots:
                feed.screenshot(path=str(screenshots / f"{state}.png"))
            if state == "right":
                page.get_by_role("link", name="Voice assistant").click()
                page.get_by_text("Voice controls and settings", exact=True).click()
                page.get_by_label("Camera for visual questions").select_option("A")
                page.get_by_text("Keyboard input", exact=True).click()
                page.get_by_label("Type a question or command").fill("What is in front of me?")
                page.get_by_role("button", name="Ask", exact=True).click()
                expect(page.locator('#conversation-log [data-speaker="assistant"]').last).to_contain_text("person (right)")
                page.get_by_role("link", name="Judge view").click()

        # A phone that loses Wi-Fi cannot send DELETE. Wait for server-side expiry.
        expect(canvas).to_be_hidden(timeout=8500)
        expect(rows).to_have_count(0)
        http.put(host + "/api/frame", headers=headers, data=jpeg.getvalue(), timeout=3).raise_for_status()
        worker.poll()
        expect(rows.filter(has_text="person").first).to_be_visible()
        http.delete(host + "/api/frame", headers=headers, timeout=3).raise_for_status()
        expect(canvas).to_be_hidden()
        expect(rows).to_have_count(0)
        expect(feed.locator(".feed-status")).to_have_text("Offline")
        if screenshots:
            feed.screenshot(path=str(screenshots / "offline.png"))
        check_dual_views(page, host, desktop, model, screenshots)
        page.get_by_role("button", name="Show sample feeds").click()
        expect(rows).to_have_count(4)
        expect(page.locator("#depth-heading")).to_be_hidden()
        expect(page.locator("#detection-measure")).to_have_text("Distance")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(DEFAULT_WEIGHTS), task="detect")
    launch = """const {createServer}=require('./web/server.cjs');
    const s=createServer({agent:{filename:':memory:'}});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"""
    with subprocess.Popen(["node", "-e", launch], cwd=Path(__file__).resolve().parents[1],
                          stdout=subprocess.PIPE, text=True) as server:
        try:
            host = "http://127.0.0.1:" + str(int(server.stdout.readline()))
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                exercise(browser.new_page(), host, model, args.screenshots)
                browser.close()
        finally:
            server.terminate()
    print("Passed: Camera A YOLO, aligned stereo map, B disconnect with A updating, and Agent response.")


if __name__ == "__main__":
    main()
