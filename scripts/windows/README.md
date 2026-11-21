# Windows 一键启动

`Start-VisionAssist.ps1` 在后台启动网页服务和 CV worker，等两者都就绪后打印仪表盘地址，并记下进程号，之后用 `-Stop` 只结束这两个进程。日志写在仓库根目录的 `.visionassist/`。

## 先准备一次

按 [CV README](../../cv/README.md) 和 [Agent README](../../llm/README.md) 准备依赖，默认位置如下；放在别处时用参数或同名环境变量指定。

| 需要的东西 | 默认位置 | 参数 / 环境变量 |
| --- | --- | --- |
| CV 的 Python | `cv/.venv` | `-CvPython` / `VISIONASSIST_CV_PYTHON` |
| Agent 的 Python（含 aiortc，WebRTC 接收端也用它） | `llm/.venv` | `-AgentPython` / `VISIONASSIST_PYTHON` |
| 语音与人脸模型目录 | `llm/models` | `-Models` / `VISIONASSIST_MODELS` |
| YOLO 权重 | `cv/models/yolo11n.pt` | — |
| 路沿分割权重（关闭路沿告警时不需要） | `cv/models/road-segformer-b0.onnx` | `-NoRoadAlerts` |
| [ADE20K 门和墙分割权重](../../cv/README.md#前方门提示) | `cv/models/scene-segformer-b0.onnx` | `-DoorAlerts` / `-WallAlerts` |
| 前端生产构建 | `cd web && npm ci && npm run build -- --webpack` | — |

Ollama 没在运行时脚本会自动启动它。NVIDIA 显卡的 GPU 依赖见 CV README 的 GPU 一节。

## 常用命令

```powershell
.\scripts\windows\Start-VisionAssist.ps1
.\scripts\windows\Start-VisionAssist.ps1 -RtcLowConfig path\to\webrtc-480x640.json
.\scripts\windows\Start-VisionAssist.ps1 -CvDevice cpu -NoRoadAlerts
.\scripts\windows\Start-VisionAssist.ps1 -Stop
```

- `-RtcLowConfig`：当前支架 480 × 640 WebRTC 的双目标定 JSON，开启实时深度和物体米数。不给时没有米制深度。
- `-StereoConfig`：传给 `--stereo-config`。横穿预测和带米数的路沿读取的是这份配置里的相机几何，只给 `-RtcLowConfig` 时这两项不工作。
- `-CvDevice`：默认 `auto`，按 CUDA、Apple MPS、CPU 选择。
- `-DoorAlerts` 开启门分割。在仪表盘的 **Spoken alerts** 选择 **Walking alerts** 后可听到门提示。
- `-WallAlerts` 开启墙提示。在 Walking 模式下，需要双目确认墙在前方 1.5 米内。
- `-Port`：默认 8775；不同端口可以同时跑多套。

## 手机通过 HTTPS 接入

电脑用 localhost 打开仪表盘时，手机需要单独的 HTTPS 入口。把证书 `server.pem` 和私钥 `server.key` 放在仓库外的同一个目录里，在该目录运行：

```powershell
$env:PHONE_HOST='你的局域网地址'; $env:PHONE_PORT='8776'; $env:DESKTOP_PORT='8775'
node <仓库路径>\web\phone-proxy.cjs
```

再把手机实际访问的源（例如 `https://172.20.10.2:8776`）写进 `.visionassist/phone-origin-8775.txt`，然后重新启动脚本，配对二维码就会指向这个地址。证书必须覆盖 `PHONE_HOST`，并被手机信任。
