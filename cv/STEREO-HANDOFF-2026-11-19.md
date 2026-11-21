# VisionAssist 双目深度交接

## 当前接手点 · 2026-11-20 晚间

- **分支与部署。** 本机分支为 `cv-stereo-depth-map`。目前 8775 部署的功能版本是 `c2e428c`，包含上一张分割图保留逻辑 `39b917f` 和来自队友 `cv` 分支的 ADE20K 分割合并 `b5a142d`。更新此文时，8775 桌面服务、8776 手机 HTTPS 代理和 Camera A worker 都在线，A、B 都有新帧。Git 的本地 `origin/cv-stereo-depth-map` 跟踪点为 `c021460`，接手时以本机功能版本为准。
- **实时控制台。** Camera A、**Stereo depth map**、**Camera A segmentation** 从左到右同排，窄窗口可以横向滚动。Camera B 位于下一排，可用 **Show Camera B** 控制可见性，浏览器会记住该设置。卡片、状态行和检测列表都有预留空间，警报浮在角落。深度图可切 StereoSGBM 或 RAFT-Stereo。分割结果短暂缺失或过期时，面板保留上一张图和图例，同时标记 **Last result · waiting for update**。更换或断开 Camera A 会清除该图。
- **平面与避障。** `--plane-ransac` 使用原始公制深度拟合并独立验证支撑面。平面合格时，**Show meters** 可显示物体离面高度，适用的障碍判断使用 3D 走廊和高度阈值。平面失效时，障碍与风险回到原有 2D 规则，路沿与横穿预测可在同一配对、有效 PnP 和 500 ms 时限内沿用变换后的姿态，其余情况使用静态俯仰角。**Show plane overlay** 默认关闭。开启后，绿色标出训练内点和合格中央留区，橙色标出高于误差带且处在有效高度区间的点，默认下限至少 0.05 m、上限 2.0 m。橙色是调试几何提示，告警还依赖走廊和风险条件。
- **分割的用途。** `--scene-segmentation` 启用 Camera A 的 ADE20K 分类图，150 类，后台默认每秒最多启动三次推理。ADE20K 当前服务于实时预览和录像对比。独立的 `--road-alerts` 使用 Cityscapes 模型提供路沿预警和可用的道路、人行道候选掩码，本次 8775 的启动参数没有这个开关。
- **录像与对比。** **Record A + B → Stop and save** 保存同步两路 JPEG/PNG、`timestamps.csv` 和当次标定，随后生成左右并排原片。在 **Saved recordings** 选中录像，点 **Generate depth comparison** 输出 **Camera A 原图｜StereoSGBM｜RAFT-Stereo｜Camera A 语义分割** 四栏 MP4。旧的三栏对比用 **Regenerate with segmentation** 重生成。四栏使用同一批原始配对帧，分割从对应的 A 原图离线重算。固定 4 FPS 便于逐帧查看，播放中的算法等待消失，深度缺测和分类边缘波动仍可能存在。

## 复现当前运行方式

在仓库根目录执行。手机使用 **Pair a phone → Wi-Fi · WebRTC** 获取 A、B 的配对码，两台选择 **480 × 640 · WebRTC**。按标定位置安装两台手机，Rice 对应左侧 A，Jia 对应右侧 B。重启桌面服务后需要重新配对。只重启 Camera A worker 可以保留桌面会话和手机配对，适合更新仅涉及 Python 处理的改动。手机端代码变动后，先在 Safari 重新载入相机页。

```sh
(cd web && npm run build -- --webpack)
VISIONASSIST_PORT=8775 \
  VISIONASSIST_RTC_PYTHON="$PWD/.visionassist/rtc-env/bin/python" \
  VISIONASSIST_CV_PYTHON="$PWD/.visionassist/rtc-env/bin/python" \
  node web/server.cjs

# 另一个终端，从仓库根目录运行。
.visionassist/rtc-env/bin/python -u cv/live_camera.py \
  --server http://127.0.0.1:8775 --device mps --cpu-threads 4 \
  --rtc-low-config cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json \
  --plane-ransac --scene-segmentation
```

桌面入口是 [localhost:8775](http://localhost:8775/)，手机 HTTPS 源由本机 `.visionassist/phone-origin-8775.txt` 指定。局域网变化时按 [Web README](../web/README.md#双手机-webrtc) 核对 8776 代理、证书和网卡地址。没有 MPS 的机器可用 `--device cpu`。当前分割使用 `cv/models/scene-segformer-b0.onnx`，RAFT 使用本机 `.visionassist/RAFT-Stereo/raftstereo-realtime.pth` 和对应模型代码。下载及依赖见 [CV README](README.md#camera-a-室内外语义分割) 和 [Web README](../web/README.md#录制用于测试的-ab-素材)。

480 × 640 WebRTC 的配对上界包括 A/B 拍摄时间差和两台设备的校时误差，当前门槛为 65 ms。若控制台提示缺采集时间，先确认两路都在发帧，再检查 `X-RTC-Timing-Source` 与手机代理转发的 `X-Capture-Stream`。此前实机确认两端均使用 `frame-capture-time`，抽查 8 对同步帧的上界为 27–52 ms。Apple GPU 加速 YOLO，现有 RAFT 路径仍使用 CPU。

## 验证与证据边界

| 项目 | 已有证据 |
| --- | --- |
| M1–M5 | 支撑平面拟合、离线评测、实时 3D/2D 回退、动态姿态、路沿落差及控制台已接通。M1/M2 整改、M3 与 M4 已通过项目审查。M5 有完整回归和叠层启闭的同帧 HTTP 验证。 |
| 真实桌面评测 | 同一段 37 对同步帧，自动掩码下 StereoSGBM 为 0/37，RAFT-Stereo 为 22/37。RAFT 的逐帧留区 P90 中位数为 15.3 mm。手工 ROI 下，只有 7 帧同时拟合通过且有杯身高度，帧间标准差 20.5 mm。固定印花点的高度稳定性与绝对测距精度仍待实测。 |
| PnP 先验 | 合成运动序列上，快速路径将单帧拟合均值从 8.22 ms 降到 6.93 ms，法向抖动持平。该组计时独立于 PnP 耗时。37 对实拍帧回放中没有通过校验的 PnP 位姿，现场加速仍待验证。 |
| 最新界面与导出 | 桌面 1440 px 和窄屏 390 px 都验证了三栏对齐。通过真实录像的 4 对同步帧验证旧对比升级、四栏 MP4 解码与 CSV 帧号对齐。最近 Web 21/21、生产前端 3/3、构建与 TypeScript 检查通过。最近全量 CV 70/70 通过于语义分割合并版 `b5a142d`。 |

可分享的自动掩码数据见 [summary.json](results/ransac-m2-auto-mask/summary.json)。本机逐帧数据和日志位于 `.visionassist/plane-eval/`、`.visionassist/scene-merge/`、`.visionassist/ui-layout/` 和 `.visionassist/scene-comparison/`。最近部署日志在 `.visionassist/deploy/comparison-8775.6OGTxM/`。录像、权重和证书保存在本机 Git 忽略目录。桌面与纸杯的实验背景及旧快照说明见 `.visionassist/handoffs/2026-11-20/HANDOFF.md`。

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
