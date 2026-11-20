# VisionAssist 桌面与手机相机原型

## 先看设计

- 电脑打开 `index.html`。默认进入 **Judge view**，显示两路示例画面和物体框。配对后进入实时模式，左侧显示 Camera A 和 YOLO 框，右侧显示双目深度图。首次测距前需要为当前支架完成双目标定。顶部 **Voice assistant** 切到用户页。
- 手机打开相机入口 `camera.html`。首屏只有配对所需操作。配对、授权并启动相机后，页面只显示取景画面。离开页面会结束采集。

## 试实际配对

需要 Node.js 24。相机配对和文字记忆使用 Node 内置模块。语音转写、对话和视觉识别的本地模型配置见 [Agent 使用和 CV 联调](../llm/README.md)。

1. 进入本目录，运行 `node server.cjs`。在同一台电脑打开 `http://localhost:8765/` 和 `http://localhost:8765/camera`，可以先试双标签页配对。
2. 两台手机实测需要与电脑网络互通，并能访问受信任的 HTTPS 地址。准备证书后，运行 `node server.cjs "证书路径.pem" "私钥路径.pem"`。电脑和手机使用证书覆盖的同一主机名和端口。电脑打开根路径，手机打开 `/camera`。证书和私钥请保存在项目目录外。
3. 电脑点击 **Pair a phone**，为 Camera A 生成配对码，在第一台手机输入。第二台手机使用 Camera B 的独立配对码。选好 A 或 B 后，手机扫描弹窗二维码即可进入相机页，配对码会自动填好。点 **Connect camera** 并允许使用摄像头。也可手动输入六位码，五分钟内有效且只能使用一次。
4. 从 **Voice assistant** 提问、录音、登记和删除记忆。先完成本地模型准备。**Show sample feeds** 是 Judge view 的独立示例。

当桌面使用 localhost、手机通过单独的 HTTPS 代理访问时，启动桌面服务前将环境变量 `VISIONASSIST_PHONE_ORIGIN` 设为手机实际可访问的 HTTPS 源（含端口）。也可将该源保存在本机的 `.visionassist/phone-origin-8765.txt`，文件名中的数字对应桌面端口。环境变量优先。二维码指向该源的 `/camera`。直接通过同一个局域网 HTTPS 地址打开桌面和手机时，服务会自动采用该地址。新手机需要能访问这个网络并信任相机站点的 HTTPS 证书。

本地服务用低频 JPEG 帧预览。Agent 的 YOLO 问答和个人物品识别依赖 CV 程序通过本机接口提交同帧检测。Qwen 单帧问答和亲友识别可以读取已经配对的相机帧。Judge view 的样例照片和距离为演示数据。

手机配对页的 **Upload quality** 提供两种选择。Standard 以 JPEG 上传，长边最多 640 px。Original pixels 向浏览器请求 1920 × 1080，并以浏览器实际给出的宽高上传无损 PNG，目标约每秒一对。手机画面会显示采集和上传尺寸。A、B 都选同一模式、保持相同方向。桌面录像使用完整上传尺寸并编码为 WebM；视频本身仍有压缩。更换上传尺寸或镜头后，按新配置重新标定。

## 验证接口

运行 `node --test pairing.test.cjs ../llm/agent.test.cjs`。覆盖配对和隔离、过期画面、Agent 接口、同帧检测和 SQLite 持久化。

## Camera A 检测与双目深度图

同一控制台配对左右两台手机。Camera A 提供检测画面；Camera B 提供双目匹配所需的另一个视角。控制台读取同一份 `/api/preview/A` 响应中的 JPEG、检测框和深度图，按同一帧一起显示。深度图越亮表示越近，黑色为缺测。B 断开时清除深度图及框上的米数，A 继续更新。运行方法和实机校准步骤见 [CV 说明](../cv/README.md)。
