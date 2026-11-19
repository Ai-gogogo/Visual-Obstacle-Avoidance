# Dual-camera and single-image object detection

Run the detector on one local photo. It writes `annotated.jpg` and `detections.json` into a new directory. Both use the display orientation of the image, including the rotation stored by a phone camera.

## Setup

From the repository root, using Python 3.12 on macOS or Linux:

```sh
python3.12 -m venv cv/.venv
. cv/.venv/bin/activate
python -m pip install -r cv/requirements.txt
mkdir -p cv/models
curl -fL https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt -o cv/models/yolo11n.pt
```

The official YOLO11n detection checkpoint used here has SHA-256 `0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1`. The model runs locally on CPU. Inference uses a 640-pixel input size, a 0.40 confidence threshold, a 0.70 IoU threshold for suppressing overlapping detections, and at most 40 objects per image (the existing CV API limit).

## Run on one image

```sh
python cv/detect_image.py path/to/photo.jpg --output cv/results/my-photo
```

Each object has a label, confidence, position, bounding box and relative depth. The box format is `[x1, y1, x2, y2]`, normalized to the original display width and height. Split the image into three equal vertical strips. The strip containing the horizontal midpoint of the box determines its position. The first boundary belongs to `center` and the second to `right`. A wide object can span all three strips and still be labeled `center`. An empty result is `{"objects": []}`. These fields can be paired with the server-provided frame ID when integrating the live adapter.

## Reproduce the example and tests

The input is the [bus photo bundled with Ultralytics 8.4.0](https://github.com/ultralytics/ultralytics/blob/v8.4.0/ultralytics/assets/bus.jpg). The original single-image baseline includes an [annotated image](examples/bus/annotated.jpg) and [JSON](examples/bus/detections.json). To run the current detector on the same input, including relative depth, use a fresh directory:

```sh
BUS_IMAGE=$(python -c 'from importlib.util import find_spec; from pathlib import Path; print(Path(find_spec("ultralytics").origin).parent / "assets/bus.jpg")')
python cv/detect_image.py "$BUS_IMAGE" --output cv/results/bus
python -m unittest discover -s cv -v
node --test web/pairing.test.cjs llm/agent.test.cjs
```

On the example photo, the CPU run found a bus at center and four people (two left, one center, one right). The lowest-confidence person is partly outside the left edge. This is a one-image functional check.

The CV suite checks the two position boundaries, box normalization, annotation coordinates, real detections on the bus photo and an empty prediction on a rotated blank JPEG. Confidence scores can vary slightly by runtime.

## Live cameras A and B

Use the same environment and weights as the single-image detector. From the repository root, start the Web server in one terminal and the CV worker in another:

```sh
node web/server.cjs
```

```sh
. cv/.venv/bin/activate
python cv/live_camera.py
```

Open the dashboard at `http://localhost:8765/`, generate independent pairing codes for **Camera A** and **Camera B**, then open `/camera` on each device and enter its code. Either camera can run alone. HTTP localhost works for a two-tab test on one computer. For a physical phone, follow the [Web HTTPS setup](../web/README.md). Run the worker on the server computer and pass `--server https://localhost:8765` if the certificate includes localhost. Use a hostname that resolves to loopback on that computer and is accepted by the server and certificate. For a private CA, set `REQUESTS_CA_BUNDLE` to the PEM file for its trust chain.

In Voice assistant, select **Camera A** or **Camera B** and ask “What is in front of me?” Each camera has a separate polling thread, resident YOLO model and HTTP session. Its frame cache is scoped to the dashboard source. Each result is submitted with the camera ID and the ETag of the JPEG actually processed. An unchanged frame skips inference. An empty prediction clears the object list. The Agent answers from the most recent accepted detection within the server’s five-second freshness window. Newer preview frames can arrive while inference runs. Re-pairing replaces the old camera slot. Leave the worker running to pick up the new stream, or stop it with Ctrl+C.

The live integration tests in `test_live_camera.py` replay JPEGs through the actual Node server and Agent with real YOLO weights. They exercise the running CLI, a camera change during inference, unchanged and expired frames, simultaneous feeds, B disconnecting while A continues, and re-pairing. Run them with the CV environment active and Node available:

```sh
python -m unittest discover -s cv -p test_live_camera.py -v
```

## Live object tracking

When the same person moves across a camera view, the dashboard box and detection table show a label such as `person #A-1`. The JSON carries `"track_id": "A-1"` while `frame_id` changes with each image. Each camera and dashboard stream tracks independently. Pairing a replacement phone starts fresh tracks immediately. Numbers may repeat after restarting the CV worker.

The tracker matches boxes of the same class using overlap and predicted movement. A missed detection clears the box from that frame. If YOLO detects the object again within 1.2 seconds, a matching box can recover the ID. Longer gaps start new tracks. Fully overlapping objects and abrupt motion can break continuity. Tracking runs on live streams only.

The CV tests include a 21-frame replay of two people moving in opposite directions using real YOLO, as well as a box-level crossing test that changes detection order. To try it on a phone, point the camera at two objects of the same class. In the desktop dashboard, watch their individual numbers while moving the camera slowly.

## Relative depth within one camera frame

The single-image JSON and the live preview expose `relative_depth` on every detection. The dashboard shows it beside the position. In Voice assistant select one camera and ask “哪个物体更近？” or “Which object is farther?” The answer uses the same accepted YOLO frame as the preview.

- `near` and `far` identify the nearer and farther groups among comparable objects in that image. The labels can change when a reference object leaves the view.
- `unknown` covers single objects, ambiguous ordering and unsupported objects. A missing field from an older producer is treated as `unknown`.

This baseline assumes an upright camera viewing objects standing on the same level ground. It uses the vertical positions of their visible ground contacts, approximated by the bottom centers of YOLO boxes. Eligible classes include people, chairs and vehicles. Boxes within 1% of an image edge, detections below 0.5 confidence and contacts inside another box are excluded. The highest and lowest contacts must span at least 12% of the image height. Objects within 4% of either extreme receive its label. Intermediate objects stay unknown. If a same-class object in the apparent far group is over 25% taller in the image than one clearly in front, the frame is ambiguous. All thresholds use image coordinates. The method produces no metric distance.

### Controlled checks

Run `python -m unittest discover -s cv -v` with the environment above. The geometry tests use a pinhole camera and known placements. The live test composites a bundled person crop at projected sizes and positions and sends JPEGs through real YOLO, pairing, preview and Agent routes.

| Scene | Observed result |
| --- | --- |
| Chair at 2 m, visibly larger bus at 6 m on level ground (projected boxes) | Chair near, bus far |
| Two people at simulated 2 m and 4 m, left/right placements reversed between A and B | Correct order in both camera previews and selected-camera answers |
| Single person, similar ground contacts, or hidden contact without a second reference | Unknown |
| Chair at 2 m raised onto a 1.4 m platform, floor chair at 4 m (projected boxes) | Unknown because apparent height contradicts the contact ordering |
| Same raised chair with a standing person at 4 m (projected boxes) | Incorrectly orders the raised chair as far and the person as near |

Steps, raised surfaces, camera roll and occlusion can invalidate the contact cue. These checks cover controlled inputs. Field accuracy on handheld phone footage has yet to be measured.

## Dual-camera performance

To log accepted detections during a real run, use `python cv/live_camera.py --metrics /path/to/new.csv`. Each row identifies the source, camera and frame. Both timestamps used for latency come from the server: from receipt of the complete JPEG to acceptance of the matching detection. This includes waiting for the worker to poll, decoding, CPU inference and result submission. Phone capture, upload to the server and browser rendering occur outside this interval. Duplicate submissions do not add samples.

Run the isolated benchmark from the repository root:

```sh
python cv/benchmark_dual_camera.py --output /tmp/visionassist-dual-run
```

It starts the normal worker and a private loopback server, pairs two simulated phones, and replays the bundled bus (A) and soccer (B) photos as JPEGs with a 640-pixel maximum edge and quality 70. Both streams submit a new frame every 220 ms. Measurement starts after both cameras return actual detections. Effective FPS is the number of distinct frames received and accepted within the same 30-second window divided by 30. Latency is summarized by median and nearest-rank P95.

The [saved baseline](results/dual-camera-baseline/summary.json) and [per-frame timings](results/dual-camera-baseline/frames.csv) are from one CPU run on this Mac. The input cadence limits the observed FPS. Physical phones and Wi-Fi may give different results.

## Obstacle risk

Live objects include `risk: "normal" | "caution" | "urgent"` in the existing same-frame POST.
A path candidate with confidence of at least 0.50 must appear with the same tracking ID in two
consecutive processed frames within the tracking gap to reach `caution`. Both frames must also
meet the urgency rule to reach `urgent`. The box must occupy at least 25% of image height, with
its bottom at or below 80% of image height for relative depth `near`, or 90% for unknown depth.
A relatively `far` candidate can still reach `caution`. The live worker tracks evidence separately
for each paired camera stream and reuses the result when retrying the same frame.

These image-space thresholds are intended for controlled demos with a forward-facing camera.
Relative depth represents ordering within one image. A `normal` result means this rule did
not confirm a hazard.

## Personal-item features

The live worker extracts a versioned `spatial-hsv-v1` descriptor from each eligible
object's box in the exact frame sent to YOLO. An eligible detection has confidence
at least 0.50, a crop at least 24 pixels on each side, and a label other than
`person`. The optional same-frame payload field is
`item_feature: { "version": "spatial-hsv-v1", "vector": [...] }`, with 540
normalized values. The Agent uses it for enrollment and matching with existing
saved samples and computes missing descriptors from the same JPEG when needed.
Dashboard preview responses omit the descriptor.

To try it, center one detectable object, say “这个水杯是我的”, confirm, then ask
“我的水杯在哪里？”. Try a differently colored object of the same YOLO class as
well. This descriptor distinguishes color layouts and can confuse objects with
similar appearances or react to lighting changes.

## Live detection JSON v1

The worker sends one result per processed JPEG to
`POST /api/cv/detections?source_id=…&camera_id=A` (or B). The frame GET supplies the
unquoted ETag for `frame_id` and the server's JPEG receipt time from
`X-CV-Frame-Ms` for `timestamp_ms` (Unix milliseconds).

```json
{
  "schema_version": 1,
  "camera_id": "A",
  "frame_id": "<ETag>",
  "timestamp_ms": 1760000000000,
  "objects": [
    {
      "label": "chair",
      "confidence": 0.93,
      "bbox": [0.31, 0.28, 0.69, 0.90],
      "position": "center",
      "relative_depth": "near",
      "track_id": "A-12",
      "obstacle_candidate": true,
      "risk": "caution"
    }
  ]
}
```

The service validates metadata against the pinned frame. Legacy payloads with
only `frame_id` and `objects` are normalized to v1 on receipt. The Agent consumes
the accepted snapshot directly, including any validated `item_feature` fields.
`GET /api/preview/A` returns the same public fields plus the matching base64
`jpeg`, with item descriptors omitted. In a preview, `objects: null` means
the JPEG has no current detection result, while `objects: []` means the CV
worker processed the frame and found no objects.
