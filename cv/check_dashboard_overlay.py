"""Exercise the Camera A dashboard in Chromium with actual YOLO and HTTP pairing."""
import argparse
import base64
import io
import subprocess
from pathlib import Path

import requests
from PIL import Image
from playwright.sync_api import expect, sync_playwright
from ultralytics import YOLO
from ultralytics.utils import ASSETS

from detect_image import DEFAULT_WEIGHTS
from live_camera import CameraAWorker


def exercise(page, host, model, screenshots):
    with page.expect_response(lambda r: r.url == host + "/api/session") as session:
        page.goto(host)
    desktop = {"Authorization": "Bearer " + session.value.json()["token"]}
    page.get_by_role("button", name="Pair a phone").click()
    page.get_by_role("button", name="Code for Camera A").click()
    code = page.locator(".pair-code").inner_text().replace(" ", "")
    phone = requests.post(host + "/api/join", json={"code": code}, timeout=3).json()["token"]
    page.get_by_role("button", name="Close pairing dialog").click()

    feed = page.locator('[data-camera="A"]')
    canvas = feed.locator("canvas")
    with Image.open(ASSETS / "bus.jpg") as photo:
        person = photo.crop((44, 390, 244, 907))
    person.thumbnail((122, 272))
    headers = {"Authorization": "Bearer " + phone, "Content-Type": "image/jpeg"}
    with requests.Session() as http:
        worker = CameraAWorker(host, model, http)
        for state, left in [("left", 24), ("right", 500), ("empty", None), ("reappeared", 24)]:
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
                    position = "left" if left == 24 else "right"
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
        page.get_by_role("button", name="Show sample feeds").click()
        expect(rows).to_have_count(4)
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
    print("Passed: moving box, empty frame, disconnect, Agent response and sample view.")


if __name__ == "__main__":
    main()
