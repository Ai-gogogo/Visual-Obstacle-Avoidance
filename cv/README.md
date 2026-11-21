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

In live mode, the left panel displays Camera A with YOLO boxes, and the right panel displays a depth map aligned to that exact A frame. The default worker loads one YOLO predictor for A, with explicit CPU, CUDA and Apple GPU support. B supplies matching frames in the selected JPEG or lossless PNG mode. Pair A first to test detection; pair B and load a calibration for these phones to measure meters. If stereo is unavailable, A keeps detecting and the right panel explains why. The built-in sample scene remains available separately.

For a keyboard scene question, select Camera A in Voice assistant. The worker pins its YOLO result to the ETag of the actual frame. The historical two-predictor comparison is available with `--dual-yolo`; the dual-camera benchmark opts into that mode.

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

The live worker defaults to `--device auto`, which selects CUDA first, then
Apple MPS, and falls back to CPU when the installed PyTorch reports neither GPU.
MPS uses FP32. CPU threads still apply to CPU work, including RAFT-Stereo. The default input size
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

When stereo gives the object a measured `depth_m`, distance replaces the box-size rule: both
frames at 1.2 m or closer reach `urgent`, and candidates farther than 3 m stay `normal`.

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
saved samples and computes missing descriptors from the same frame when needed.
Dashboard preview responses omit the descriptor. To use the optional 768-value SigLIP2
encoder, install `transformers` and its tokenizer dependencies in the CV environment and
start the worker with `--item-encoder siglip2`. The first run loads
`google/siglip2-base-patch16-224` from the local cache or Hugging Face. Saved samples
match other descriptors from the same encoder.

To try it, center one detectable object, say “这个水杯是我的”, confirm, then ask
“我的水杯在哪里？”. Try a differently colored object of the same YOLO class as
well. This descriptor distinguishes color layouts and can confuse objects with
similar appearances or react to lighting changes.

## Live detection JSON v1

The worker sends one result per processed frame to
`POST /api/cv/detections?source_id=…&camera_id=A` (or B). The frame GET supplies the
unquoted ETag for `frame_id` and the server's frame receipt time from
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
`jpeg` or `png` field, with item descriptors omitted. In a preview, `objects: null` means
the frame has no current detection result, while `objects: []` means the CV
worker processed the frame and found no objects.

## 双手机绝对深度（米）

用固定的横向支架把 A 放在左侧、B 放在右侧，两部手机朝前且视野重叠。测量量是沿 **A 相机光轴** 的前向深度 Z。双目校正后，深度来自校正焦距（像素）乘以基线（米）再除以视差（像素）。代码将深度映射回 A 的原始图像坐标。Dashboard 的深度图越亮表示越近，黑色表示该像素缺少有效匹配。A 的每个检测框可以带 `depth_m`，取框中央一半区域内有效深度的中位数。有效像素太少或深度分布太分散时显示「—」。框中混有背景时，估计也可能落在背景上。左侧检测框和表格显示 A 的有效米数，右侧深度图使用同一帧的 A 图像坐标。

### 填参数或用棋盘格自动标定

全部现场参数在 [stereo_config.json](stereo_config.json)。默认关闭。已有双目标定结果时，填好下表各项，将 `enabled` 改为 `true`，重启 CV worker 即生效。开启前请确认配对的就是这套支架上的 A、B 手机。基线、镜头、变焦、视频裁切、分辨率、横竖屏和相对角度都需要与标定时一致。重装支架或换手机后重新标定。

| 配置字段 | 填写方式 |
| --- | --- |
| `image_size_px` | 两部手机实际上传的共同宽、高（像素）。标准 JPEG 模式的最长边最多 640 像素；原始像素 PNG 保留浏览器相机视频的尺寸。两台手机应使用与标定时相同的模式和尺寸。 |
| `baseline_m` | 两个**活动镜头光心**之间的直线距离，单位米。可用尺量作独立核对。 |
| `camera_A`、`camera_B` | 分别填写上传尺寸下的 `fx, fy, cx, cy`（像素）和 OpenCV 普通针孔模型的五项畸变系数 `[k1,k2,p1,p2,k3]`。 |
| `rotation_A_to_B`、`translation_direction_A_to_B` | OpenCV 外参约定 `X_B = R × X_A + T`。分别填 3×3 旋转矩阵和单位向量 `T / norm(T)`。平行水平安装且 B 在右侧时，理论方向为 `[-1,0,0]`。实际安装用标定结果。 |
| `max_pair_skew_ms` | 两帧采样时间差加两端时钟估计误差的上限，默认 65 ms。较小值能减少运动造成的偏差，也可能减少有效帧对。 |
| `num_disparities` | 搜索视差的像素数，正的 16 倍数且小于图宽。近物所需视差约为 `校正焦距 × 基线 / 深度`，超出搜索范围时无法测量。 |
| `min_depth_m`、`max_depth_m` | 可接受的前向深度范围，也决定预览灰阶。实际可测范围还受基线、焦距、视差搜索范围、重叠区域和纹理影响。 |

只有卷尺时，可以通过下面的工具估计其余参数。先按上文 Setup 安装依赖，启动 Web 服务，用同一个 Dashboard 配对两台手机并保持上传。实机通过 HTTPS 连接。若使用相机专用的 HTTPS 反向代理，它须转发上传请求头 `X-Sample-Ms`、`X-Clock-Error-Ms` 和响应头 `X-Server-Ms`；缺少这些时间信息时只能等待配对帧。命令里的 `--server` 与 worker 一样指向服务器本机地址。采集标定数据可以在 YOLO 启动前完成。

1. 固定两台手机，在 Chrome 打开 **Stereo calibration**。以普通 10 × 7 格棋盘为例，量好单格边长，确认 A、B 预览中都出现完整绿点。点击 **Record Stereo Video**，移动棋盘并在不同姿势停稳，结束后点击 **Stop Recording → Upload Recording**。
2. 将下面的 `single.webm` 和单格边长替换为实际录像和实测值。求解输出重投影 RMS（像素）和基线（米）。用尺量的镜头间距核对基线。桌面服务使用 CV 环境或 `VISIONASSIST_CV_PYTHON` 指定的 Python。

```sh
python cv/calibrate_stereo.py solve --video single.webm --square-mm 14.6 --output cv/stereo_config.json
python cv/live_camera.py --server https://localhost:8765
```

打开 Dashboard 的 live 模式查看 A 的深度图和 **Forward depth (A)** 列。程序用浏览器视频帧时间和通过 HTTP 估计的服务器时钟配对，优先使用可用的捕获时间，否则使用呈现时间。需要支持 `requestVideoFrameCallback` 的浏览器。手机之间没有硬件快门同步，曝光和呈现之间的差异、运动、反光、低纹理或遮挡都可能增加误差。先用带纹理的静止平面在卷尺量好的几个前向距离验证，例如从 A 镜头沿光轴放在 1、2、3 米处，记录每处误差和缺测比例，再评估移动场景。缺少匹配的 B 帧时，A 的 YOLO 检测继续运行。

### 单面和三面怎样对照

固定 A 在左、B 在右，全程保持两台设备、镜头和分辨率不变。在 Chrome 的 **Stereo calibration → Calibration target** 选目标。单面用现有 10 × 7 格普通棋盘。三面用菜单内 PDF 的 front、right、top 三张带编号的 ChArUco 棋盘，各占一面。三面预览仅标出左右相机能按编号配对的角点。每个有效姿势至少包含两个共同可见的面，每面至少有六个不共线分布的共同角点。整组要覆盖三个面。

用 **Record Stereo Video → Stop Recording → Upload Recording** 保存到本机，保存后的路径含有模式名。录像没有固定时限，达到姿势目标后点 Stop Recording。单段编码数据累计到 60 MiB 时会停录，给最后一块数据留出空间。若最终文件超过服务器的 64 MiB 上传上限，点 Download full WebM 保存整段。录制时会在后台检查刚写到录像画布的 A/B 原图。`Valid pairs` 是在已检查的同步画面对中，两路都满足当前棋盘识别条件的数量。`Distinct steady poses` 在连续识别且角点稳定至少 0.3 秒后计数，重复姿势只算一次。等待检测的画面对显示为 Checking；过载或检测失败显示为 Unchecked。停止后会继续查完已排队的帧。建议每个姿势停约 2 秒，覆盖中央、边缘、不同距离和倾角。单段标定建议达到 20 个不同稳定姿势和 60 对有效画面；三面模式还需覆盖所有面。另录的留出验算视频建议 8–10 个不同的新姿势。在线计数基于编码前的画面，离线求解按视频时间戳约每 0.3 秒取样、检测和去重，低帧率视频逐帧检查。

三面纸盒按直角建模，选硬、平整的三个相邻面。用新图覆盖原正面棋盘。正面和右面的印刷上边朝盒顶，顶面的印刷上边朝盒背，各图边缘与盒棱平行。复制 `cv/box-layout.example.json` 后，逐面填写横向五格的实测毫米数，并核对竖向五格相同。另量下面两段间距，均从**黑白格外沿**量到盒棱，单位为毫米。

| 纸面 | horizontal_gap_mm | vertical_gap_mm |
| --- | --- | --- |
| front 正面 | 格子右沿到右棱 | 格子上沿到顶棱 |
| right 右面 | 格子左沿到前棱 | 格子上沿到顶棱 |
| top 顶面 | 格子右沿到右棱 | 格子下沿到前棱 |

在仓库根目录运行下面的命令，将录像路径和量好的 JSON 换成实际文件。单面的 `14.6` mm 是本次实测五格 73.0 mm 除以五。也可用 `--pairs` 代替 `--video` 读取保存的照片批次。默认将米制配置放在输入文件或批次旁边，并在文件名中保留模式。

```sh
python cv/calibrate_stereo.py solve --mode single --video single.webm --square-mm 14.6
python cv/calibrate_stereo.py solve --mode three --video three.webm --layout measured-box.json
python cv/calibrate_stereo.py compare --video held-out.webm --configs single-single-config.json three-three-config.json
```

`held-out.webm` 是固定同一机位后另录的普通单面棋盘（可在贴三面图前录），含多个新姿势。比较命令在同一批留出角点上报告两套配置的上下偏差中位数和 P95。杯身高度另用同一段桌面录像和留出的桌面纸验证。

### 深度图边缘复核（2026-11-20）

SGBM 在计算代价时延伸搜索边界，再检查每个左右匹配的 5 × 5 窗口是否都在真实有效像素内。左右一致性、纹理和距离筛选继续生效。边缘遮挡、反光和无纹理处仍可能缺测。

对照基线为 `f54a96e` 的匹配算法。使用 `36ad570e/relative-preview.json`，在相同录像、相同帧上计算原始有效像素占整幅图的比例，关闭 WLS 和时间滤波。

| 录像 | 抽样 | 原覆盖率均值 | 新覆盖率均值 |
| --- | --- | ---: | ---: |
| 棋盘 36ad570e | 归档 held-corners.csv 中的 18 帧 | 6.53% | 10.55% |
| 纸杯 d8be72ae | 第 25 至 375 帧，每 25 帧取一对，共 15 帧 | 2.56% | 4.98% |

在 18 帧留出的棋盘角点处，将可用深度转换为校正后的水平视差，与独立检测到的左右角点横坐标差核对。旧版 528 个可用角点中有 396 个误差 ≤2 px，新版 553 个中有 418 个。26 个从无测量变为有测量的角点中，22 个在 2 px 内。纸杯录像复用原桌面掩码、拟合随机种子与留区阈值，仍为 0/15 帧通过。该结果仅支持边缘可用范围改善。

### 导出逐像素深度图

同一对已保存的左右 JPEG 或 PNG 也可离线处理，不需要 YOLO 权重。将命令中的路径替换为同一对标定尺寸的图片，输出目录须是新目录。

```sh
python cv/stereo_depth.py path/to/A.jpg path/to/B.jpg --config cv/stereo_config.json --output /tmp/depth-check
```

`depth_m.npy` 保存与 A 图像同尺寸的 float32 米制深度，缺测像素为 NaN。`depth_preview.png` 适合目视查看。Dashboard 为节约带宽显示缩略图，物体读数使用全分辨率深度图。

## 车行道与人行道语义分割

移植自 `cv` 分支的 `d064052`。在 CV 虚拟环境安装本目录 requirements，然后从仓库根目录下载、核验权重：

```sh
mkdir -p cv/models
curl -fL https://huggingface.co/Xenova/segformer-b0-finetuned-cityscapes-512-1024/resolve/18b12204d4c787afb8df24e49efc36a20d9f16d0/onnx/model.onnx -o cv/models/road-segformer-b0.onnx
echo 'ffd5ceb33f7c7a969bc69d3ad7ab06017de15c42085e7ed10be8ed8d23b10fec  cv/models/road-segformer-b0.onnx' | shasum -a 256 -c -
python -m unittest discover -s cv -p test_road_edge.py -v
```

在能导入 `cv/` 下模块的 Python 进程中，加载一次模型，然后对 Camera A 的 RGB 帧调用：

```python
from road_edge import DEFAULT_ROAD_CONFIG, RoadEdge

estimator = RoadEdge.load(DEFAULT_ROAD_CONFIG, stereo=None)
road, sidewalk = estimator.segment(image.convert("RGB"), estimator.confidence)
```

两个布尔掩膜与输入图像同尺寸。路沿距离和目标横穿预测都使用未滤波的米制深度。棋盘格单位的标定需要输入实测格长才能提供米制深度。Show meters 只控制深度图和检测框的米数显示。

### 可选深度滤波与米数

Chrome 实时深度图提供三个独立开关，初始均关闭。Edge-aware filter 在逆深度图上以左图灰度引导加权最小二乘平滑，仅插补至少有三个相容邻点的小孔。Temporal median 使用同一对摄像头近期的三帧，在局部亮度和深度均稳定时取中值。滤波影响预览；距离只取原始有效双目观测。黑色表示当前仍未知。

Show meters 显示相对于 Camera A 光轴的前向距离。若标定 JSON 带有 `"units":"checker_squares_only"`，在页面输入同一张棋盘连续五格的**实测总毫米数**，转换系数为该数除以 5000。未量格长时保持空白。公制标定直接使用米。对准中心圆圈可读该点的距离；目标框内的距离沿用项目的可靠深度聚合。没有足够观测时显示未知。输入的尺度适用于当前页面会话；更换镜头、机位或标定后请重新核对。

## 前方车行道边缘预警

在上面的双手机标定、配对和 HTTPS 服务可用后，运行：

```sh
cv/.venv/bin/python cv/live_camera.py --road-alerts --server https://localhost:8765
```

Camera A 用 Cityscapes SegFormer-B0 分割车行道和人行道，寻找从脚下方向的人行道走向前方车行道的交界。程序在交界附近取多个地面像素的双目深度，使用 A 的标定射线计算横向位置和水平前向距离，选择行走通道内最近且有一段连续像素支持的交界。Dashboard 在对应的 A 帧上用黄色圆圈标出取值位置，图下显示距离。B 为 A 提供双目匹配；运行 worker 时加上 `--dual-yolo` 也可独立检测 B。

- 默认在 **5 米**内提醒，进入 **3 米**再升级，每档需要连续两张已接受的不同帧确认，间隔不超过 1.2 秒。退到 5.6 米外或持续看不到交界至少一秒后可重新提示。按 Dashboard 的语音语言设置通过现有 Piper 播报。[语音模型和浏览器播放设置](../llm/README.md)
- 未标定、缺少同步帧或交界纹理不足时，连续看到前方交界可播报「前方可能是车行道」，并显示距离不可用。道路延伸到侧面时，程序以朝前通道筛选交界。当前假设手机朝向与行走方向一致，地面近似水平。
- [road_config.json](road_config.json) 中的 `pitch_down_deg` 默认 0，镜头从水平向下倾斜 10° 时填 10。`corridor_width_m` 是通道总宽，默认 0.9 米。`caution_m`、`urgent_m` 和 `rearm_margin_m` 分别控制两级提示和重新触发的距离余量。改完重启 worker。匹配范围还取决于 [stereo_config.json](stereo_config.json) 中的有效深度范围和标定参数。
- 首次实机验证可用卷尺在封闭路段标出 5 米和 3 米，分别从正面、斜向接近并沿路沿平行行走。没有可见人行道、已走上车道、路口被车辆遮挡或在坡道上时，可能漏报或误报。

## 预测人车从侧面进入前方通道

完成 A/B 双目标定后，普通 `cv/live_camera.py` 会自动启用路径侵入预测。安装路沿分割模型是 `--road-alerts` 的要求，单独使用横穿预测只需要原有 YOLO、OpenCV 和双目标定。默认相机 A 朝向与短时间内的行走方向一致，按直线通道预测未来 2 秒内、前方 6 米范围的进入事件。

系统复用 YOLO 的目标类别、跟踪 ID 和逐帧米制深度。每对 A 帧都先遮掉检测框，再用校正过畸变的背景三维点和下一帧光流，以 RANSAC 估计相机的旋转与平移。只有背景匹配覆盖足够多的区域、双向光流吻合、当前双目深度也支持该姿态时才采用结果。旧的目标位置先旋转到当前坐标轴，再估算相对速度。背景平移用于排除仅由用户侧移造成的假横穿。转身过快、缺少特征、目标刚换 ID、双目掉线或两台手机重新配对时停止累积预测证据。

行人、自行车、摩托、汽车、公交、卡车或狗的近侧边缘仍在通道外，且连续两个运动区间都显示朝内移动时，系统估算它的边缘何时进入通道。满足时间和前向距离条件后，A 的检测框显示方向和预计进入时间，Dashboard 沿用现有语音通道播报「右侧自行车可能横穿前方，请小心」一类提示。进入时间以采集帧为起点，服务器丢弃已经过期的预警。同一轨迹同方向的告警在 5 秒内去重。目标已在通道内时，已有的占道风险规则继续工作。

调整 [road_config.json](road_config.json) 中的 `corridor_width_m`（通道总宽）和 `pitch_down_deg`（正数表示下俯）。`intrusion.enabled` 控制此功能，`horizon_s` 默认为 2，`max_forward_m` 默认为 6，`max_turn_deg_s` 默认为 35。修改后重启 worker。双目参数和时钟配对要求与上文的绝对深度功能一致。

封闭场地实测可以覆盖手机转动而物体静止、人员平行于通道行走，以及人员从通道两侧横穿这三种情况。记录告警相对实际入道的提前量，以及漏报和误报。急转弯、移动背景占满视野、严重遮挡、稀疏深度和目标突然变向会影响预测。此处的时间是按短时速度估计的入道时间，碰撞还取决于使用者之后的路线和速度。

## 同机位对比 JPEG 与 WebRTC

两台手机先选择原图 PNG 完成标定。保持机位、镜头、倍率、方向、棋盘位置和光线固定。使用同一份启用的标定文件，分别用 **Standard · JPEG** 和 **Low latency · WebRTC** 配对两台相机。从根目录运行：

```sh
python cv/compare_stereo_transport.py --server http://127.0.0.1:8786 --mode jpeg --stereo-config PATH
python cv/compare_stereo_transport.py --server http://127.0.0.1:8786 --mode webrtc --stereo-config PATH
```

把 `--server` 换成当前 CV worker 使用的本地地址。WebRTC 等两台手机均显示 **Stereo timing ready** 后再测。脚本用同一批已配对图像报告配对率、配对时差上界 P95、校正后的棋盘角点纵向误差和全图深度有效比例，尺寸不符的帧单独计数。静止棋盘用于检查几何，建议另用运动的可见计时器或闪烁光源核对两部手机的时间估算；浏览器相机管线偏差需要实测。配对门槛取标定配置与 65 ms 的较小值，比较时计入两路时钟估算误差。

CV 默认对 A 路的最新帧运行 YOLO。WebRTC 和 JPEG 帧各自配对。双目几何通过对照后，以 `--stereo-config PATH --allow-webrtc-stereo` 启动 CV；JPEG/PNG 的既有深度路径照常使用标定文件。
