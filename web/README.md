# VisionAssist 桌面与手机相机原型

两台 iPhone 通过数据线连接 Mac 时，请按[双 USB 采集说明](../wired/README.md)操作。

## 先看设计

- 电脑打开 `http://localhost:8765/`。默认进入 **Judge view**，显示两路示例画面和物体框。配对后进入实时模式，显示 Camera A 的 YOLO 检测、Camera B 和双目深度图。首次测距前需要为当前支架完成双目标定。顶部 **Voice assistant** 切到用户页。
- 手机打开相机路由 `/camera`。首屏显示配对操作。配对、授权并启动相机后，页面显示取景和镜头状态。离开页面会结束采集。原有 `/index.html` 和 `/camera.html` 链接会跳转到对应路由。

## 试实际配对

需要 Node.js 24。前端使用 React、Next.js App Router 和 TypeScript。相机配对和文字记忆使用 Node 内置模块。语音转写、对话和视觉识别的本地模型配置见 [Agent 使用和 CV 联调](../llm/README.md)。

1. 进入本目录，运行 `npm ci` 和 `npm run dev`。在同一台电脑打开 `http://localhost:8765/` 和 `http://localhost:8765/camera`，可以先试双标签页配对。
2. 两台手机实测需要与电脑网络互通，并能访问受信任的 HTTPS 地址。准备证书后，运行 `npm run build`，然后运行 `npm start -- "证书路径.pem" "私钥路径.pem"`。电脑和手机使用证书覆盖的同一主机名和端口。电脑打开根路径，手机打开 `/camera`。证书和私钥请保存在项目目录外。
3. 电脑点击 **Pair a phone**，为 Camera A 生成配对码，在第一台手机输入。第二台手机使用 Camera B 的独立配对码。选好 A 或 B 后，手机扫描弹窗二维码即可进入相机页，配对码会自动填好。点 **Connect camera** 并允许使用摄像头。也可手动输入六位码，五分钟内有效且只能使用一次。
4. 从 **Voice assistant** 提问、录音、登记和删除记忆。先完成本地模型准备。**Show sample feeds** 是 Judge view 的独立示例。

当桌面使用 localhost、手机通过单独的 HTTPS 代理访问时，启动桌面服务前将环境变量 `VISIONASSIST_PHONE_ORIGIN` 设为手机实际可访问的 HTTPS 源（含端口）。也可将该源保存在本机的 `.visionassist/phone-origin-8765.txt`，文件名中的数字对应桌面端口。环境变量优先。二维码指向该源的 `/camera`。直接通过同一个局域网 HTTPS 地址打开桌面和手机时，服务会自动采用该地址。新手机需要能访问这个网络并信任相机站点的 HTTPS 证书。

本地服务用低频 JPEG 帧预览。Agent 的 YOLO 问答和个人物品识别依赖 CV 程序通过本机接口提交同帧检测。Qwen 单帧问答和亲友识别可以读取已经配对的相机帧。Judge view 的样例照片和距离为演示数据。

## 双手机 WebRTC

在 Mac 上安装 `cv/rtc-requirements.txt` 中的依赖，启动网页服务时把 `VISIONASSIST_RTC_PYTHON` 设为该 Python 解释器的绝对路径。在 **Pair a phone → Wi-Fi · WebRTC** 分别为 A、B 生成二维码，两台 iPhone 在同一局域网内用 Safari 打开 HTTPS 相机页。保持机位与竖屏方向，Rice 对应 A，Jia 对应 B。默认档位是 **480 × 640 · WebRTC**，也可选 **1080 × 1920 · WebRTC**。接收端校验解码尺寸，分析快照保留相同像素尺寸。网络需允许两台手机与 Mac 的媒体流量。USB 配对保留在同一弹窗。

如果 Mac 用 8775 提供桌面 HTTP、8776 单独提供手机 HTTPS，在存放现有 `server.pem` 和 `server.key` 的目录运行以下命令，把网卡地址和仓库路径换成本机实际值。手机代理会转发配对、WebRTC 信令、状态和时钟；仪表盘与 USB 管理接口由本机桌面服务提供。

```sh
PHONE_HOST='你的局域网地址' PHONE_PORT=8776 DESKTOP_PORT=8775 node /path/to/Visual-Obstacle-Avoidance/web/phone-proxy.cjs
```

480 × 640 USB 标定可以在实拍几何一致时复用。给 CV worker 传入 `--rtc-reference` 和已有的高、低标定，Mac 会在有时间匹配的 A/B 帧后比较两侧静止场景特征。参考文件可用 `python cv/rtc_geometry.py 已标定的低像素双目录像.webm reference.npz` 从原录像生成。保持左右顺序及相同背景。若背景已更换或特征不足，应另用固定棋盘对照验证。手动确认机位、镜头、裁切与标定一致后，才使用 `--allow-webrtc-stereo`。查看实收尺寸、解码 FPS 以及同步状态可用手机相机页。

## 验证接口

运行 `npm test` 检查配对和隔离、过期画面、Agent 接口、同帧检测和 SQLite 持久化。运行 `npm run typecheck` 检查 TypeScript。完成 `npm run build` 后，运行 `npm run test:frontend` 验证生产服务的两个页面、静态资源和同源配对接口。

## 前端分层

| 层 | 入口 |
| --- | --- |
| 设计变量 | `styles/tokens.css` 定义语义色、控件尺寸和动效时长 |
| 通用组件 | `components/` 与 `styles/components.css` |
| 页面布局 | `app/` 提供桌面和手机路由，`styles/layout.css` 负责响应式布局 |
| 功能模块 | `features/` 分开维护语音、对话、记忆、监看、标定、配对和手机采集 |
| 交互与状态 | 手机表单和语音界面使用 React 状态。设备、音频和轮询由带清理逻辑的功能控制器管理。会话请求由 `services/desktop-session.js` 管理 |
| 无障碍与动效 | `shared/accessibility.js`、`styles/motion.css` 与组件的原生表单和公告区域 |

`server.cjs` 在同一端口处理设备、CV 和 Agent 的 `/api/*` 请求，其余请求交给 Next.js。桌面页切换面板时保留同一相机会话。视频帧、检测、深度图和记忆从现有接口按需读取。

使用 Tab 移动焦点，Enter 激活链接和按钮，Escape 关闭弹窗、停止播报或取消当前请求。**Reduce motion** 与系统的减少动态效果设置都能关闭动效。声波只用录音模块提供的真实麦克风 RMS。系统原生选择菜单保留平台交互，150 ms 动效用于页面内展开面板。

显式断开相机时，下一次相机状态轮询就会公告；突然失联时，等待服务判定画面已过期。**Saved memory** 中的历史观察保留相机、时间与位置，回答也会标明来源。

## Camera A 检测与双目深度图

相机配对页的 **Original pixels · lossless PNG** 按浏览器实际采集尺寸上传无损帧，目标节拍为每秒一帧。**Standard** 沿用长边最多 640 px 的 JPEG。实时页默认按帧的宽高比显示，可点 **Actual pixels** 按接收到的像素 1:1 查看。做双目标定时，两台设备应选择相同模式，保持镜头、方向和采集尺寸固定。标定工具可读取保存的 PNG 和 JPEG 帧。

同一控制台配对左右两台手机。Camera A 提供检测画面；Camera B 提供双目匹配所需的另一个视角。控制台读取同一份 `/api/preview/A` 响应中的 JPEG、检测框和深度图，按同一帧一起显示。深度图越亮表示越近，黑色为缺测。B 断开时清除深度图及框上的米数，A 继续更新。运行方法和实机校准步骤见 [CV 说明](../cv/README.md)。

480 × 640 WebRTC 模式下，手机在同一个视频帧回调中复制画面并读取浏览器给出的 `captureTime`。手机定期用往返探测估算与 Mac 的时差，将供深度计算的 JPEG、换算后的采集时间和时间误差一起上传。采集时间可用时，CV 帧响应的 `X-RTC-Timing-Source` 为 `frame-capture-time`。手机视频预览仍通过 WebRTC 发送。当浏览器没有提供采集时间或网络校时暂不可用时，接收端继续按原有 WebRTC 校时规则判断帧能否配对。更新手机端后要重新载入 Safari 相机页，输入新配对码即可使用新版。

实时查看时，在 **Stereo depth map → Depth algorithm** 选择 StereoSGBM（默认）或 RAFT-Stereo。下一对同步帧会使用所选算法。两者共用当前机位的标定，RAFT 首次使用时会加载本机权重。

## 录制用于测试的 A/B 素材

在本机 Judge view 配对 A、B 后，点击 **Record A + B**。数字表示已经写入磁盘的同步帧对数。点击 **Stop and save** 后，在 **Saved recordings** 中选录像，可播放和下载左右并排的原片。手机换机或超过 5 秒没有新帧时，录制自动结束，已经保存的帧仍可使用。短暂缺少同步帧时跳过该时刻。

每次录制保存在项目本机的 `.visionassist/recordings/<id>/`。A/B 文件保留接收端的原始 JPEG 或 PNG；`timestamps.csv` 记录左右帧 ID、各自的采样时间、帧间时差及含时钟误差的上界（最多 65 ms）。`stereo.mp4` 按采样时间回放。刷新网页或重启服务后可以重新选择已保存的录像。

本机以当前标定支架录制 **480 × 640 WebRTC** 或已标定的 USB 档位时，录制目录同时保存所用的标定文件。选中录像后点击 **Generate depth comparison**，即可生成 Camera A、StereoSGBM、RAFT-Stereo 三栏 MP4。两种方法读取同一对原始帧。对比视频以 4 FPS 回放，支持 **Previous frame / Next frame**；颜色和帧号在三栏之间对齐。改变机位、镜头或裁切后需要更新对应标定。

原片导出需要安装了 PyAV 和 Pillow 的 Python。对比导出还需要 CV 依赖及 `opt_einsum`，并使用 `.visionassist/RAFT-Stereo/` 的官方代码和 `raftstereo-realtime.pth` 权重。服务优先使用 `VISIONASSIST_CV_PYTHON`，其次使用项目中的 `.visionassist/rtc-env/bin/python`。导出失败时原始帧和时间戳仍然保留，可修复依赖后重试。
