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

## Live stereo rig (A detects, B supplies the second view)

Use the same environment and weights as the single-image detector. From the repository root, start the Web server in one terminal and the CV worker in another:

```sh
node web/server.cjs
```

```sh
. cv/.venv/bin/activate
python cv/live_camera.py
```

Open the dashboard at `http://localhost:8765/`, generate independent pairing codes for **Camera A** and **Camera B**, then open `/camera` on each device and enter its code. Camera A can run alone for YOLO. HTTP localhost works for a two-tab test on one computer. For a physical phone, follow the [Web HTTPS setup](../web/README.md). Run the worker on the server computer and pass `--server https://localhost:8765` if the certificate includes localhost. Use a hostname that resolves to loopback on that computer and is accepted by the server and certificate. For a private CA, set `REQUESTS_CA_BUNDLE` to the PEM file for its trust chain.

In live mode, the left panel displays Camera A with YOLO boxes, and the right panel displays a depth map aligned to that exact A frame. The default worker loads one YOLO predictor for A on either CPU or CUDA. B only uploads JPEGs for stereo matching. Pair A first to test detection; pair B and load a calibration for these phones to measure meters. If stereo is unavailable, A keeps detecting and the right panel explains why. The built-in sample scene remains available separately.

For a keyboard scene question, select Camera A in Voice assistant. The worker pins its YOLO result to the ETag of the actual JPEG. The historical two-predictor comparison is available with `--dual-yolo`; the dual-camera benchmark opts into that mode.

The live integration tests in `test_live_camera.py` replay JPEGs through the actual Node server and Agent with real YOLO weights. They exercise the running CLI, a camera change during inference, unchanged and expired frames, simultaneous feeds, B disconnecting while A continues, and re-pairing. Run them with the CV environment active and Node available:

```sh
python -m unittest discover -s cv -p test_live_camera.py -v
```

## Live object tracking

When the same person moves across a camera view, the dashboard box and detection table show a label such as `person #A-1`. The JSON carries `"track_id": "A-1"` while `frame_id` changes with each image. The default live pipeline tracks Camera A independently for each dashboard session. Pairing a replacement phone starts fresh tracks immediately. Numbers may repeat after restarting the CV worker.

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

To log accepted detections (A by default, both with `--dual-yolo`), use `python cv/live_camera.py --metrics /path/to/new.csv`. Each row identifies the source, camera and frame. Both timestamps used for latency come from the server: from receipt of the complete JPEG to acceptance of the matching detection. This includes waiting for the worker to poll, decoding, inference and result submission. Phone capture, upload to the server and browser rendering occur outside this interval. Duplicate submissions do not add samples.

The live worker defaults to `--device auto`, which selects CUDA when the
installed PyTorch can use it and otherwise selects CPU. The default input size
is 640. CPU mode defaults to up to four PyTorch intra-op threads for Camera A
alone and one thread per predictor with `--dual-yolo`. Override with
`--cpu-threads` to suit the machine. Use
`--device cuda:0 --half` to compare FP16 with CUDA FP32. Check small-object
detections before choosing a smaller resolution or FP16. Both cameras poll at
50 ms by default and fetch JPEGs only when discovery reports a new frame;
`--poll-ms` lets you trade polling traffic for latency.

Run the isolated benchmark from the repository root:

```sh
python cv/benchmark_dual_camera.py --device cpu --output /tmp/visionassist-cpu
python cv/benchmark_dual_camera.py --device cuda:0 --half --output /tmp/visionassist-cuda
```

It starts the normal worker and a private loopback server, pairs two simulated phones, and replays the bundled bus (A) and soccer (B) photos as JPEGs with a 640-pixel maximum edge and quality 70. Both streams submit a new frame every 220 ms. Measurement starts after both cameras return actual detections. Effective FPS is the number of distinct frames received and accepted within the same 30-second window divided by 30. Latency is summarized by median and nearest-rank P95. On CUDA hosts with
`nvidia-smi`, the summary includes sampled median GPU utilization and peak
VRAM usage for each reported GPU. These are device-wide readings and include
other processes on the GPU. CPU runs and runs without samples report `gpu: null`.

An earlier [Mac baseline](results/dual-camera-baseline/summary.json) is available with
[per-frame timings](results/dual-camera-baseline/frames.csv). For this optimization,
both versions were rerun on the same 2-vCPU Linux workspace with YOLO11n at 640
and PyTorch 2.9.0 CPU. These are 30-second replay results with 137 uploads per
camera and a theoretical input limit of about 4.55 FPS per camera.

| Camera | Previous FPS | Current FPS | Previous median / P95 | Current median / P95 |
| --- | ---: | ---: | ---: | ---: |
| A | 3.73 | 4.53 | 231 / 366 ms | 121.5 / 162 ms |
| B | 3.87 | 4.53 | 183 / 330 ms | 107.5 / 142 ms |

The workspace had no CUDA GPU. CUDA and physical-phone results require a run
on the deployment machine.


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

## 双手机绝对深度（米）

用固定的横向支架把 A 放在左侧、B 放在右侧，两部手机朝前且视野重叠。测量量是沿 **A 相机光轴** 的前向深度 Z。双目校正后，深度来自校正焦距（像素）乘以基线（米）再除以视差（像素）。代码将深度映射回 A 的原始图像坐标。Dashboard 的深度图越亮表示越近，黑色表示该像素缺少有效匹配。A 的每个检测框可以带 `depth_m`，取框中央一半区域内有效深度的中位数。有效像素太少或深度分布太分散时显示「—」。框中混有背景时，估计也可能落在背景上。左侧检测框和表格显示 A 的有效米数，右侧深度图使用同一帧的 A 图像坐标。

### 填参数或用棋盘格自动标定

全部现场参数在 [stereo_config.json](stereo_config.json)。默认关闭。已有双目标定结果时，填好下表各项，将 `enabled` 改为 `true`，重启 CV worker 即生效。开启前请确认配对的就是这套支架上的 A、B 手机。基线、镜头、变焦、视频裁切、分辨率、横竖屏和相对角度都需要与标定时一致。重装支架或换手机后重新标定。

| 配置字段 | 填写方式 |
| --- | --- |
| `image_size_px` | 两部手机**实际上传 JPEG** 的共同宽、高（像素）。网页将最长边缩至最多 640 像素。标定工具直接采集该尺寸。 |
| `baseline_m` | 两个**活动镜头光心**之间的直线距离，单位米。可用尺量作独立核对。 |
| `camera_A`、`camera_B` | 分别填写上传尺寸下的 `fx, fy, cx, cy`（像素）和 OpenCV 普通针孔模型的五项畸变系数 `[k1,k2,p1,p2,k3]`。 |
| `rotation_A_to_B`、`translation_direction_A_to_B` | OpenCV 外参约定 `X_B = R × X_A + T`。分别填 3×3 旋转矩阵和单位向量 `T / norm(T)`。平行水平安装且 B 在右侧时，理论方向为 `[-1,0,0]`。实际安装用标定结果。 |
| `max_pair_skew_ms` | 两帧采样时间差加两端时钟估计误差的上限，默认 65 ms。较小值能减少运动造成的偏差，也可能减少有效帧对。 |
| `num_disparities` | 搜索视差的像素数，正的 16 倍数且小于图宽。近物所需视差约为 `校正焦距 × 基线 / 深度`，超出搜索范围时无法测量。 |
| `min_depth_m`、`max_depth_m` | 可接受的前向深度范围，也决定预览灰阶。实际可测范围还受基线、焦距、视差搜索范围、重叠区域和纹理影响。 |

只有卷尺时，可以通过下面的工具估计其余参数。先按上文 Setup 安装依赖，启动 Web 服务，用同一个 Dashboard 配对两台手机并保持上传。实机通过 HTTPS 连接。若使用相机专用的 HTTPS 反向代理，它须转发上传请求头 `X-Sample-Ms`、`X-Clock-Error-Ms` 和响应头 `X-Server-Ms`；缺少这些时间信息时只能等待配对帧。命令里的 `--server` 与 worker 一样指向服务器本机地址。采集标定数据可以在 YOLO 启动前完成。

1. 打印平整棋盘格，量出**单个方格边长**。例如 10×7 个方格有 **9×6 个内角点**。固定两台手机，每次同时看见完整棋盘。采集约 15–25 个姿态，改变棋盘的倾角、方向、距离和在画面中的位置，按回车采集时保持棋盘静止。
2. 运行下面的采集和求解命令。把示例的内角点数和 `25` 毫米换成实物的值。求解会输出重投影 RMS（像素）、基线（米），并将参数写入指定文件。基线应与实测镜头间距相符。RMS 明显超过约 1 像素时，检查棋盘尺寸、镜头设置、图像清晰度和姿态覆盖。


For manual capture from Chrome, pair both cameras and open **Stereo calibration**.
Hold the 10 × 7 square checkerboard still until both views show green corners.
Press **Capture Stereo Pair** or Space for each new pose. Pairs are stored under
`.visionassist/calibration/<batch>/` in the project. Pass that batch directory to
`solve --pairs` below. Re-pairing a camera starts a new batch. The desktop server
uses the CV virtual environment or the interpreter set in `VISIONASSIST_CV_PYTHON`.

```sh
python cv/calibrate_stereo.py capture --server https://localhost:8765 --pairs /tmp/rig-pairs
python cv/calibrate_stereo.py solve --pairs /tmp/rig-pairs --corners 9 6 --square-mm 25 --output cv/stereo_config.json
python cv/live_camera.py --server https://localhost:8765
```

打开 Dashboard 的 live 模式查看 A 的深度图和 **Forward depth (A)** 列。程序用浏览器视频帧时间和通过 HTTP 估计的服务器时钟配对，优先使用可用的捕获时间，否则使用呈现时间。需要支持 `requestVideoFrameCallback` 的浏览器。手机之间没有硬件快门同步，曝光和呈现之间的差异、运动、反光、低纹理或遮挡都可能增加误差。先用带纹理的静止平面在卷尺量好的几个前向距离验证，例如从 A 镜头沿光轴放在 1、2、3 米处，记录每处误差和缺测比例，再评估移动场景。缺少匹配的 B 帧时，A 的 YOLO 检测继续运行。

### 导出逐像素深度图

同一对已保存的左右 JPEG 也可离线处理，不需要 YOLO 权重。将命令中的路径替换为同一对标定尺寸的图片，输出目录须是新目录。

```sh
python cv/stereo_depth.py path/to/A.jpg path/to/B.jpg --config cv/stereo_config.json --output /tmp/depth-check
```

`depth_m.npy` 保存与 A 图像同尺寸的 float32 米制深度，缺测像素为 NaN。`depth_preview.png` 适合目视查看。Dashboard 为节约带宽显示缩略图，物体读数使用全分辨率深度图。
