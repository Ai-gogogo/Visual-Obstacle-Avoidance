# VisionAssist 双目深度交接

## 当前接手点 · 2026-11-21

- **分支与部署。** `cv-stereo-depth-map` 的 S1–S5 功能版截至 `7ad749f`，已推到同名 GitHub 分支。8775 正在运行该功能版加本机改动。默认标定、Depth source 显示名称、独立的障碍标签开关和四栏视频导出改动尚在本机工作区。交接时已核实 8775 和 8776 HTTPS 均可访问，桌面、手机代理和 Camera A worker 均在运行。实体手机连线以控制台当时显示为准。
- **新机位。** 默认 `480 × 640 · WebRTC` 标定名为 `18pro+15pro_2026-11-21_09-03-42`，来自 09:03:42 保存的棋盘录像 `754fb6cb`。取录像后段 35 个不同姿势，26 个拟合、9 个留出验证。左右校正垂直误差 P50 为 0.35 px，P95 为 0.94 px，拟合基线约 20.8 cm。米制比例沿用每格 14.605 mm。绝对距离仍待用尺复核。新机位的一对留出帧通过 8775 回放获得同帧深度，有效覆盖率为 36.6%。命名配置、旧默认备份、拟合脚本和验证日志保存在本机 `.visionassist/calibrations/18pro+15pro_2026-11-21_09-03-42/`。
- **实时控制台。** Camera A、**Stereo depth map**、**Camera A segmentation** 同排，窄窗口可横向滚动。Camera B 位于下方，可用 **Show Camera B** 切换。Depth source 默认项显示新标定名称。分割暂缺时保留上一张图和图例并显示等待状态，更换或断开 Camera A 会清除该图。
- **录像与对比。** **Record A + B → Stop and save** 保留同步原图、时间戳、当次标定和原版左右并排 `stereo.mp4`。本机 **Generate depth comparison** 生成 **Camera A + YOLO｜StereoSGBM｜RAFT-Stereo｜Camera A 语义分割** 四栏 MP4，4 FPS，分割图例最多 8 项。**Regenerate with segmentation** 更新四栏文件。2026-11-20 23:42 的 403 帧录像已按此重生成，原始材料校验值一致。新的录制使用当前标定，已有录像各自保留拍摄时的配置。

## 现场怎么测 S1–S5

1. 两台手机按标定时的 A/B 顺序装好，保持镜头、倍率、方向和相对位置。通过 **Pair a phone → Wi-Fi · WebRTC** 分别配对，选择 **480 × 640 · WebRTC**。Depth source 保持命名的 Live 默认项，Depth algorithm 先试 **RAFT-Stereo**。WLS 和 Temporal median 只影响预览，可以先留空。
2. 勾 **Show meters**。Camera A 的框显示可用的中位距离和离支撑面高度。最近距离以 P10 表示，同时比中位距离至少近 0.20 m 和 15% 时才出现 `min`。要验证实物精度，用固定机位、带纹理的目标和两个尺量距离复测。
3. 勾 **Show obstacle labels**。出现 **Plane OK** 且当前凸起通过几何和语义筛选时，深度图下方会显示例如 `pole 1.1m` 的摘要。**Show plane overlay** 独立控制深度图着色，绿色标出支撑面拟合内点及合格留区，橙色标出高于误差带的点。两个选项均默认关闭，后台 RANSAC、测量和分类照常运行。想保持深度图原色，只勾 **Show meters** 和 **Show obstacle labels**。
4. **Last depth frame · waiting for update** 表示正在等待新的配对结果。检查两路是否持续发帧、是否同为 480 × 640 WebRTC，以及拍摄时差和校时误差之和是否在 65 ms 内。Camera B 断联、结果过期或检测帧与深度帧不匹配时，预览清除最近距离和未知凸起摘要。

## 复现当前运行方式

在项目根目录运行。已运行的本机服务由 `launchctl` 管理，标签为 `com.visionassist.local.desktop8775`、`com.visionassist.local.phone8776` 和 `com.visionassist.local.worker8775`。日志位于 `.visionassist/deploy/s5-8775.sdxyor/`。只更新 CV 或更换默认标定时，重启 worker 即可保留配对。前端重新构建后需要重启桌面服务来加载新页面，两台手机随后重新配对。

```sh
(cd web && npm run build -- --webpack)
VISIONASSIST_PORT=8775 \
  VISIONASSIST_RTC_PYTHON="$PWD/.visionassist/rtc-env/bin/python" \
  VISIONASSIST_CV_PYTHON="$PWD/.visionassist/rtc-env/bin/python" \
  node web/server.cjs

# 另一个终端，从项目根目录运行。
.visionassist/rtc-env/bin/python -u cv/live_camera.py \
  --server http://127.0.0.1:8775 --device mps --cpu-threads 4 \
  --weights cv/models/yolo11n-seg.pt \
  --rtc-low-config cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json \
  --plane-ransac --road-alerts --scene-segmentation
```

桌面入口是 [localhost:8775](http://localhost:8775/)。手机 HTTPS 源由本机 `.visionassist/phone-origin-8775.txt` 指定，网卡变化时按 [Web README](../web/README.md#双手机-webrtc) 核对地址与证书。默认标定路径的本机文件和命名 JSON 内容一致，供 worker、菜单及新录像共同使用。搭建新工作区时需取得本机配置和界面改动，GitHub 上的 S1–S5 基线仍使用仓库原来的标定。权重、校准录像、发布日志和原始素材保存在本机 Git 忽略目录。使用 [CV README](README.md#camera-a-室内外语义分割) 核对依赖。

## 融合路径和验收证据

- **实例分割 + 原始深度。** YOLO-Seg 的实例掩码对齐 Camera A。S2 优先取腐蚀后的物体内部测距、测高，按证据质量回退。S3 将前景轮廓合并后膨胀 4 px，保留椅腿之间的支撑面点。同一份扣除结果用于 RANSAC、PnP 和未知凸起去重。平面验证失败时继续走原有 2D 回退。
- **Cityscapes + 凸起几何。** `--road-alerts` 的 CPU SegFormer-B0 一次推理同时提供道路、人行道候选和静态语义。扣除已检测前景后的凸起先通过几何筛选，再用至少 12 个有效语义像素和 50% 得票门槛定类。ADE20K 是另一条 CPU 推理路径，由 `--scene-segmentation` 启用，负责 150 类彩色预览及录像对比。
- **接口。** S5 放行 P10 和凸起语义标量。实拍 HTTP 回放核对了字段透传与断联清除，检测请求及预览响应没有实例像素掩码或 `semantic_map`。Apple MPS 承担 YOLO 推理，RAFT-Stereo 和两条 SegFormer 路径使用 CPU。

| 阶段 | 验证与边界 |
| --- | --- |
| [S1](results/segmentation-s1/README.md) `38bd53a` | YOLO 检测和分割权重均可用。MPS 逐对耗时差中位数 8.00 ms，P95 22.48 ms。 |
| [S2](results/segmentation-s2/README.md) `389b9a8` | 合成镂空目标验证测距、测高和回退。有效平面帧的 CPU 测量后处理 P95 为 3.64 ms。 |
| [S3](results/segmentation-s3/README.md) `133c615` | 同源 RAFT 的桌面段和室内段各 37 帧，有效测距率分别从 28.0% 到 30.9%、62.4% 到 65.5%。平面通过数分别为 22→19、0→0。前景扣除 P95 为 0.61–0.77 ms，桌面段完整后处理 P95 为 4.31 ms，高于 4 ms 目标。 |
| [S4](results/segmentation-s4/README.md) `63597b9` | 实拍 HTTP 验证开启道路预警时每帧一次 Cityscapes 推理，关闭时零次。合成 12 连通域语义投票 P95 为 0.145 ms。 |
| [S5](results/segmentation-s5/README.md) `7ad749f` | CV 85/85、Web 21/21、生产前端 3/3、构建和 TypeScript 均通过。本机拆分显示开关后，生产前端 3/3 再通过，8775 页面已核实。 |

M1–M5 的历史平面证据见 [自动掩码评测](results/ransac-m2-auto-mask/summary.json) 及本机 `.visionassist/plane-eval/`。当时同一桌面录像用纯检测权重运行，StereoSGBM 为 0/37，RAFT-Stereo 为 22/37。实拍绝对距离、已知高度和新机位的平面通过率仍待测。本机逐帧实拍数据与 HTTP 日志见 `.visionassist/seg-eval/`，更早的实验材料见本机交接 `.visionassist/handoffs/2026-11-20/HANDOFF.md`。

## 历史记录 · 2026-11-19

### 项目和工作状态

项目为 Ai-gogogo/Visual-Obstacle-Avoidance，用户负责 CV。此前在 cv 分支按功能推进单图 YOLO 与左中右位置、实时推理、按 frame_id 叠框、双路 YOLO、追踪、相对深度，以及后续障碍、风险、视觉特征、JSON 输出与性能工作。队友的双 YOLO 方案仍是这次工作的出发点。历史功能测试与今天的双目实物测距验收是两件事。

当前分支为 `cv-stereo-depth-map`，手动采图功能的基线为 `429d224`。这条路线默认 A 跑 YOLO，A 和 B 的同步帧共同计算深度，结果对齐到 A。左侧为检测，右侧为深度。此前在 Chrome 观察到两个连续更新的时刻，左右 frame_id 相同。该检查验证显示同步，深度准确性需要独立检验。实测 CV 与标定可以独立于语音、Piper 和本地语言模型进行。

手动采图界面与本记录一同提交。涉及 cv/inspect_checkerboard.py、cv/README.md、web/calibration.cjs、web/calibration.js、web/index.html、web/server.cjs 和 web/ui.css。

### 硬件、标定与观察

- 左侧 A 是 iPhone，右侧 B 实际是 iPad。允许不同型号。标定与使用时必须保持两镜头相对位置、朝向、镜头和倍率一致。用户说右侧设备手持，是否在具体哪些帧间移动过尚未确定。可将两台分别靠稳，或装在同一块硬板上，仅移动棋盘。
- 最初试过屏幕棋盘，随后改用贴平的纸质棋盘。纸上为 10 × 7 个方格，检测 9 × 6 个内角点。设计边长为 25 mm，实际打印尺寸尚未用尺核验。两种介质分别采集。
- 纸棋盘第一轮 18 对，第二轮更严格地等待停稳，保存 4 对，共 44 张原始 JPEG。两路都是 480 × 640。按原程序选配对时，估计采样时差加两路时钟误差不超过 65 ms。属于软件同步。
- 第一轮常规标定留出第 3、8、13、18 对，左右对应角点的垂直误差 P95 为 3.57 px，高于当时使用的 2 px 目标。另一套受约束的相对预览拟合使用第一轮 18 对，在当时已取得的第二轮前 3 对上，垂直误差 P95 约 1.79 px；其中一个姿势的匹配深度与角点几何估计仍有明显偏差。尚未完成可靠的实物测距验证。
- 用户同意先预览灰度图，暂不显示米数。亮表示相对近，暗灰表示相对远，纯黑表示无法可靠估计。保存的一张样例仅 8.9% 的像素有深度，这是单帧结果。用户实际观察到近处水杯和远处场景都有大片未知区。
- 临时灰度预览使用棋盘格作单位。归档配置中即使字段名带 _m，数值仍是格数。只用于隐藏米数的实验预览。项目标准公制工作流应使用实测格长另做标定。

### 已知限制和待诊断问题

1. 匹配器搜索 0–143 px 视差。按当前临时标定，中央理论最近距离约 19 格；若每格确为 25 mm，约 47 cm。该值是估算，不能解释远处也大片缺失。
2. 低纹理、透明或反光杯面、左右共同视野不足、设备移动和校正残差，都可能降低有效像素。各因素对本次现象的贡献尚未分离。YOLO 识别出杯子不代表双目能测其表面。
3. 网页请求后置摄像头，浏览器决定采集尺寸；上传前长边缩至 640 px，深度显示缩略图长边 240 px。原生采集分辨率、当前是否 1× 均未经设备读数验证。0.5×/0.8× 和更高分辨率属于讨论中的选项，尚未加入设备能力显示或镜头选择。改变镜头或倍率后须重新标定。
4. 单摄像头估计相对深度是无法固定两个设备时讨论过的备选路线，尚未实现。

### 下次实测

1. 桌面 Chrome 使用 http://localhost:8775/ 。当天手机 HTTPS 转发入口为 https://10.207.75.136:8776/camera ，次日先核对局域网地址和服务。重启后须重新配对。原有 8765/8766 为另一套实例。
2. 打开 Pair a phone，分别配对 A 和 B。进入 Stereo calibration。保持设备固定，移动纸板，等两边出现绿色角点，棋盘停稳时点击 Capture Stereo Pair 或按空格。看 Saved pairs 增加后再换姿势。界面检查整板角点、尺寸、时间差和重复姿势。按钮不自动求解标定。照片在项目本地 .visionassist/calibration/<batch>/ 下，可交给 cv/calibrate_stereo.py solve。重新配对会另开批次。
3. 新按钮已用旧实拍照片验证识别、保存原图、拒绝重复和不同步、断线提示，配对回归通过。Chrome 已检查离线界面。下一步是两台实机重新配对后用按钮完成一次现场采集。
4. 带尺子和同一张纸棋盘。量连续五格再除以五。用该格长求解，留一部分新姿势单独验证校正后左右同一角点是否处在同一水平线。记录垂直误差和有效深度覆盖率。
5. 先用带文字的书在两路共同视野中央测试，再测水杯。在 60、80、100 cm 等已知位置记录有效覆盖率、估计值和实测误差。如果远处的书也匹配不到，检查两路对应点的上下错位、共同视野和同步。勿只调近距离搜索范围，也勿用黑色区域判断可通行。

### 本地材料

[纸棋盘照片、PDF、样例深度图及实验脚本归档](../.visionassist/archive/2026-11-19/paper-session.zip)。包含两轮实拍图，保存在 Git 忽略目录。归档里的实验配置与脚本用于复核当天结果。活动 Python 环境、HTTPS 转发器和旧预览脚本曾放在 /private/tmp，重启后可能需要重建。启动与标定的仓库级说明见 [CV README](README.md)。
