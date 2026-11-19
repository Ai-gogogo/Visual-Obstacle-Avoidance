# Single-image object detection

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

## Run

```sh
python cv/detect_image.py path/to/photo.jpg --output cv/results/my-photo
```

Each object has a label, confidence, position and bounding box. The box format is `[x1, y1, x2, y2]`, normalized to the original display width and height. Split the image into three equal vertical strips. The strip containing the horizontal midpoint of the box determines its position. The first boundary belongs to `center` and the second to `right`. A wide object can span all three strips and still be labeled `center`. An empty result is `{"objects": []}`. These fields can be paired with the server-provided frame ID when integrating the live adapter.

## Reproduce the example and tests

The input is the [bus photo bundled with Ultralytics 8.4.0](https://github.com/ultralytics/ultralytics/blob/v8.4.0/ultralytics/assets/bus.jpg). To reproduce the [annotated image](examples/bus/annotated.jpg) and [JSON](examples/bus/detections.json) in a fresh directory:

```sh
BUS_IMAGE=$(python -c 'from importlib.util import find_spec; from pathlib import Path; print(Path(find_spec("ultralytics").origin).parent / "assets/bus.jpg")')
python cv/detect_image.py "$BUS_IMAGE" --output cv/results/bus
python -m unittest discover -s cv -v
node --test web/pairing.test.cjs llm/agent.test.cjs
```

On the example photo, the CPU run found a bus at center and four people (two left, one center, one right). The lowest-confidence person is partly outside the left edge. This is a one-image functional check.

The CV suite checks the two position boundaries, box normalization, annotation coordinates, real detections on the bus photo and an empty prediction on a rotated blank JPEG. Confidence scores can vary slightly by runtime.
