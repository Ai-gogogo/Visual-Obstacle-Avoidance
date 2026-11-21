# VisionAssist 双目深度交接

## 当前进度 · 2026-11-20

**接手基线。** 分支 `cv-stereo-depth-map`，功能提交 `2a5fb5974d52428be02f8094016613daa595a7e6` 已推送至同名远端分支。更新交接时，本机 8775 控制台在线，A、B 都在发帧，Camera A 的 YOLO worker 报告 `mps / fp32`。Camera B 提供双目匹配所需的右图。

- **双摄同步。** 互换 A/B 身份后，约 20 秒的发端报告时间偏差跟着同一台手机走。通过 USB 读取该手机系统时钟，只比 Mac 快约 27 ms。偏差在 WebRTC 发端报告链路已可见，尚未确定它是在生成报告还是传输时产生。新版 480 × 640 WebRTC 模式从手机浏览器的同一帧回调取画面和 `captureTime`，将 JPEG、转换到 Mac 时间轴的时间戳和误差一起上传。Mac 用两帧采集时差加双方校时误差作为配对上界，门槛为 65 ms。实机双端都报告 `frame-capture-time`，抽查 8 对匹配帧的上界为 27–52 ms，控制台恢复显示深度。Safari 网页检查器与 USB 用于这次诊断，日常 Wi-Fi 采集无需开启。
- **实时深度与 YOLO。** `Stereo depth map` 下方可选 StereoSGBM（默认）或 RAFT-Stereo，两种算法共用相应机位的标定。开启 **Show meters** 后，仅在框中央有效深度点足够且一致时显示物体的前向距离。RAFT 结果晚于 750 ms 时，页面可在采集后 3.5 秒内显示匹配的 A 图与 YOLO 框，即使关闭米数或该帧没有可用深度。通过真实录像回放验证了 3 个超过原显示时限的 RAFT 帧仍有同帧检测框。
- **Camera B 显示开关。** 点击控制台顶部的 **Show Camera B** 可隐藏 B 的画面，让桌面布局只显示并排的 A 与深度图。B 继续提供测距与录制所需的帧。浏览器会记住该选择。已验证关闭、刷新后保留及重新开启。
- **Apple GPU。** 当前 worker 用 `--device mps --cpu-threads 4` 运行。真实录像交替测试的单帧中位耗时，YOLO 从 CPU 的 49.7 ms 降到 MPS 的 28.9 ms。RAFT 仍在 CPU 上约需 615 ms，整套处理从 666.6 ms 降到 646.9 ms。实测为同一段录像上的计算耗时，实时端到端延迟还包含传输和界面轮询。
- **录制与逐帧对比。** **Record A + B → Stop and save** 保存同步原图与 `timestamps.csv`，然后生成并排的 A/B 原片。手机断线时会保存已经写入的帧。在 **Saved recordings** 里选中录像，点 **Generate depth comparison** 生成 Camera A 原图、StereoSGBM、RAFT-Stereo 三栏视频。对比视频为 4 FPS，可逐帧查看。之前实拍的 47 对帧已加入录像列表，原片和对比 MP4 均解码核验为 47 帧。

## 复现当前运行方式

在仓库根目录执行。手机端进 `Pair a phone → Wi-Fi · WebRTC`，两台选择 **480 × 640 · WebRTC**。按标定时的顺序安装两台手机，Rice 对应左侧 A，Jia 对应右侧 B。重启桌面服务后重新配对。手机端代码变更后，先在 Safari 重新载入相机页再配对。

```sh
(cd web && npm run build -- --webpack)
VISIONASSIST_PORT=8775 \
  VISIONASSIST_RTC_PYTHON="$PWD/.visionassist/rtc-env/bin/python" \
  VISIONASSIST_CV_PYTHON="$PWD/.visionassist/rtc-env/bin/python" \
  node web/server.cjs

# 另一个终端，从仓库根目录运行。
.visionassist/rtc-env/bin/python -u cv/live_camera.py \
  --server http://127.0.0.1:8775 --device mps --cpu-threads 4 \
  --rtc-low-config cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json
```

桌面入口是 [localhost:8775](http://localhost:8775/)。手机 HTTPS 入口由本机 `.visionassist/phone-origin-8775.txt` 指定。网卡地址变化时，按 [Web README](../web/README.md#双手机-webrtc) 核对 8776 代理和证书。若深度界面提示某台相机缺采集时间，先确认两路都在发帧，再查对应帧的 `X-RTC-Timing-Source`，以及 `web/phone-proxy.cjs` 是否转发了 `X-Capture-Stream`。没有 Apple MPS 的机器可用 `--device cpu`。

对比生成和实时 RAFT 需要本地 `.visionassist/RAFT-Stereo/raftstereo-realtime.pth`、对应的 RAFT-Stereo 代码与 Python 依赖。环境和校准说明见 [CV README](README.md) 与 [Web README](../web/README.md)。47 对帧的本机录像目录为 `.visionassist/recordings/ee46fb76-ed87-5db5-b36f-6e568225a3a7/`，含 `stereo.mp4` 和 `stereo-depth-comparison.mp4`。实拍素材与本机证书均保存在 Git 忽略目录。

## 验证与下一步

- `2a5fb59` 提交前通过 19 项网页与接口测试、1 项生产前端测试、6 项深度测试、3 项 WebRTC 测试，以及 TypeScript 检查。网页命令为 `cd web && npm test && npm run typecheck && npm run test:frontend`，最后一项需要已完成生产构建。
- 保持已标定的机位，下一轮可用同一段静止及轻微运动的实拍录像对照两种算法。记录同步帧比例、有效深度覆盖、已知距离误差和端到端延迟。当前已验证同步、显示和导出链路。绝对距离准确性及桌面拟合仍需独立验收。
- 本机桌面拟合与纸杯高度实验的独立记录在 `.visionassist/handoffs/2026-11-20/HANDOFF.md`。

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
