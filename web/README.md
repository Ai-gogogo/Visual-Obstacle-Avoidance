# VisionAssist 桌面与手机相机原型

## 先看设计

- 电脑打开 `http://localhost:8765/`。默认进入 **Judge view**，显示两路示例画面和物体框。配对后进入实时模式，显示 Camera A 的 YOLO 检测、Camera B 和双目深度图。首次测距前需要为当前支架完成双目标定。顶部 **Voice assistant** 切到用户页。
- 手机打开相机路由 `/camera`。首屏显示配对操作。配对、授权并启动相机后，页面显示取景和镜头状态。离开页面会结束采集。原有 `/index.html` 和 `/camera.html` 链接会跳转到对应路由。

## 试实际配对

需要 Node.js 24。前端使用 React、Next.js App Router 和 TypeScript。相机配对和文字记忆使用 Node 内置模块。语音转写、对话和视觉识别的本地模型配置见 [Agent 使用和 CV 联调](../llm/README.md)。

1. 进入本目录，运行 `npm ci` 和 `npm run dev`。在同一台电脑打开 `http://localhost:8765/` 和 `http://localhost:8765/camera`，可以先试双标签页配对。
2. 两台手机实测需要与电脑网络互通，并能访问受信任的 HTTPS 地址。准备证书后，运行 `npm run build`，然后运行 `npm start -- "证书路径.pem" "私钥路径.pem"`。电脑和手机使用证书覆盖的同一主机名和端口。电脑打开根路径，手机打开 `/camera`。证书和私钥请保存在项目目录外。
3. 电脑点击 **Pair a phone**，为 Camera A 生成配对码，在第一台手机输入。第二台手机使用 Camera B 的独立配对码。配对码五分钟有效且只能使用一次。
4. 从 **Voice assistant** 提问、录音、登记和删除记忆。先完成本地模型准备。**Show sample feeds** 是 Judge view 的独立示例。

本地服务用低频 JPEG 帧预览。Agent 的 YOLO 问答和个人物品识别依赖 CV 程序通过本机接口提交同帧检测。Qwen 单帧问答和亲友识别可以读取已经配对的相机帧。Judge view 的样例照片和距离为演示数据。

## 双手机 WebRTC

安装媒体接收依赖并指定 Python 解释器。以下在 `web` 下使用 PowerShell：

```powershell
python -m venv .venv-rtc
.\.venv-rtc\Scripts\python.exe -m pip install -r ..\cv\rtc-requirements.txt
$env:VISIONASSIST_RTC_PYTHON = (Resolve-Path .\.venv-rtc\Scripts\python.exe).Path
npm run build
npm start -- "证书路径.pem" "私钥路径.pem"
```

两台手机选择 **Low latency · WebRTC** 后分别配对。电脑和手机需要在可互访的局域网，防火墙需允许接收进程的 WebRTC UDP 媒体。此模式使用局域网直连 ICE。手机显示接收帧率，首次连接或媒体中断失败时自动切换 JPEG。桌面各相机的 **Live video** 按钮可播放原始视频，再点一次回到同帧分析画面。

需要看清小物体时，可选 **Sharper video · WebRTC 720p**。手机请求 1280 × 720、约 24 FPS，上传码率上限 4 Mbps，桌面 HD 下行优先协商 H.264。取景状态显示实际收到的分辨率和帧率。HD 的分析快照长边最多 960 px。双目配对要求两台手机使用相同档位，启用 HD 测深前需要按实收尺寸核对标定。

Camera A 的实时画面旁会保留同帧分析小窗。虚线表示当前帧中的弱检测延续了已有轨迹，弱检测只用于显示。分析超过有效期后，桌面清除检测框和深度小窗。点击 **Enable warning audio** 可测试并启用本地语音告警。告警直接来自 CV 规则，桌面分别显示判断、通知和浏览器开始播放语音的时间。有校正采集时钟时显示采集估算及其误差，其他情况以服务器收到画面为起点。

接收进程持续读取视频轨道，保留每路最新解码帧，并最多每秒生成 10 张兼容快照用于现有 YOLO 和 Agent。桌面原始视频通过独立下行媒体轨道播放。CV worker 默认只对 Camera A 运行 YOLO。WebRTC 双目配对使用 RTCP 发送端报告和手机时钟校正估计采集时刻。估算不可靠时，相机页会显示 **Waiting for stereo timing**，A 路检测继续工作。

使用原图 PNG 标定，再按照 [CV 实测步骤](../cv/README.md) 对比 JPEG 和 WebRTC。用同一支架、镜头、方向和标定分辨率完成实测后，可以用 `--allow-webrtc-stereo` 为该机位启用 WebRTC 深度。

运行 `.\.venv-rtc\Scripts\python.exe ..\cv\test_rtc_transport.py` 可验证两路合成视频、桌面下行和 JPEG 回退。真机对照需用同两台手机和同一网络记录帧率、冻结、恢复时间和端到端延迟；页面显示的是解码帧率。

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
