# macOS 一键启动

在 Finder 双击 **Start-VisionAssist.command**。启动器后台运行生产网页和 YOLO，确认两者就绪后打开助手。默认端口为 8775。再次双击会打开已有服务。

从仓库根目录运行：

```sh
scripts/macos/Start-VisionAssist.command
scripts/macos/Start-VisionAssist.command --stop
scripts/macos/Start-VisionAssist.command --port 8780 --cv-device cpu --no-open
scripts/macos/Start-VisionAssist.command --door-alerts --wall-alerts
scripts/macos/Start-VisionAssist.command --port 8780 --stop
```

使用已安装的 Python 3（系统入口 /usr/bin/python3）、Node.js 24 和 Ollama。先按 web、cv 和 llm 的 README 准备生产构建、虚拟环境和模型。WebRTC 默认使用 CV 环境，如将 aiortc 安装在其他环境，可设置 VISIONASSIST_RTC_PYTHON。模型权重默认在 cv/models，有路沿模型时才默认启用路沿检测。Apple Silicon 默认自动选择 MPS。

门和墙提示需要[同一个 ADE20K 权重](../../cv/README.md#前方门提示)。墙提示还需要双目标定。修改参数前先用 `--stop` 停止同端口的旧实例。

可在仓库根目录的 .visionassist/macos.env 中按 shell 语法设置本机路径和模型环境变量。VISIONASSIST_REPO 指定要运行的集成版，VISIONASSIST_WEIGHTS 可指定独立的 YOLO 权重。Codex 问答部署可设置 VISIONASSIST_REPLY_PROVIDER=codex 和 VISIONASSIST_CODEX_BIN。使用 `--help` 查看 HTTPS、标定文件、设备及环境路径选项。HTTPS 的主机名须在证书内并可从本机访问，私有 CA 用 --cv-ca 指定。

网页和检测日志分别保存在 .visionassist/mac-web-端口.log 与 .visionassist/mac-cv-端口.log。停止操作仅处理这个启动器在指定端口创建的服务，Ollama 作为共享服务继续运行。
