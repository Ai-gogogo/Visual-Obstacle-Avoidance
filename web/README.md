# VisionAssist 桌面与手机相机原型

## 先看设计

- 电脑打开 `index.html`。默认进入 **Judge view**，显示两路示例画面和物体框。配对后进入实时模式，两路分别叠加本相机的 YOLO 框，检测列表标明 Camera A 或 B。顶部 **Voice assistant** 切到用户页。
- 手机打开相机入口 `camera.html`。首屏只有配对所需操作。配对、授权并启动相机后，页面只显示取景画面。离开页面会结束采集。

## 试实际配对

需要 Node.js 24。相机配对和文字记忆使用 Node 内置模块。语音转写、对话和视觉识别的本地模型配置见 [Agent 使用和 CV 联调](../llm/README.md)。

1. 进入本目录，运行 `node server.cjs`。在同一台电脑打开 `http://localhost:8765/` 和 `http://localhost:8765/camera`，可以先试双标签页配对。
2. 两台手机实测需要与电脑网络互通，并能访问受信任的 HTTPS 地址。准备证书后，运行 `node server.cjs "证书路径.pem" "私钥路径.pem"`。电脑和手机使用证书覆盖的同一主机名和端口。电脑打开根路径，手机打开 `/camera`。证书和私钥请保存在项目目录外。
3. 电脑点击 **Pair a phone**，为 Camera A 生成配对码，在第一台手机输入。第二台手机使用 Camera B 的独立配对码。配对码五分钟有效且只能使用一次。
4. 从 **Voice assistant** 提问、录音、登记和删除记忆。先完成本地模型准备。**Show sample feeds** 是 Judge view 的独立示例。

本地服务用低频 JPEG 帧预览。Agent 的 YOLO 问答和个人物品识别依赖 CV 程序通过本机接口提交同帧检测。Qwen 单帧问答和亲友识别可以读取已经配对的相机帧。Judge view 的样例照片和距离为演示数据。

## 验证接口

运行 `node --test pairing.test.cjs ../llm/agent.test.cjs`。覆盖配对和隔离、过期画面、Agent 接口、同帧检测和 SQLite 持久化。

## Camera A 和 B 实时检测框

从仓库根目录启动 Web 服务和 [双相机 CV 进程](../cv/README.md#live-cameras-a-and-b)。在 Judge view 分别配对两台手机后，框旁和列表中会显示类别、置信度、左中右位置。空帧清空检测框，手机离线或画面超过五秒未更新时只清空对应相机的预览和列表项。

控制台使用当前桌面会话的 Bearer token 分别读取 `GET /api/preview/A` 和 `GET /api/preview/B`。一次响应中的 `frame_id`、Base64 JPEG 和 `objects` 来自同一帧。初次等待 YOLO 或推理结果过期时，仍可预览新鲜的原图（`objects: null`）。已推理的空帧返回 `objects: []`。响应 ETag 区分原图和带结果的状态；未变返回 304，离线返回 204。

浏览器验收在临时会话中回放 JPEG，使用真实 YOLO 和 Chromium，检查框的移动、像素位置、空帧、双路的框与各自帧 ID、B 断开后 A 的更新、助手回答及样例模式。在已安装 CV 依赖的环境中，从仓库根目录运行：

```sh
python -m pip install playwright==1.56.0
python -m playwright install chromium
python cv/check_dashboard_overlay.py
```
