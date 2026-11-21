# VisionAssist 本地语音助手

## 运行

需要 Node.js 24、Python 3.11–3.13、Ollama 和支持 AudioWorklet 的浏览器。语音输入交本机 faster-whisper 转写，回复由本机 Piper 合成 WAV，再由 Dashboard 播放。浏览器阻止自动播放时可点 Read aloud。

在 agent.cjs 所在目录准备模型和依赖。下载只需进行一次。

~~~powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r agent-requirements.txt
New-Item -ItemType Directory -Force models | Out-Null
.\.venv\Scripts\hf.exe download Systran/faster-whisper-small config.json model.bin tokenizer.json vocabulary.txt --local-dir models/whisper-small
.\.venv\Scripts\hf.exe download rhasspy/piper-voices en/en_US/lessac/medium/en_US-lessac-medium.onnx en/en_US/lessac/medium/en_US-lessac-medium.onnx.json zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json --local-dir models/piper
$zoo = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models'
Invoke-WebRequest "$zoo/face_detection_yunet/face_detection_yunet_2023mar.onnx" -OutFile models/face_detection_yunet_2023mar.onnx
Invoke-WebRequest "$zoo/face_recognition_sface/face_recognition_sface_2021dec.onnx" -OutFile models/face_recognition_sface_2021dec.onnx
ollama pull qwen3:4b-instruct-2507-q4_K_M
ollama pull qwen3-vl:2b-instruct-q4_K_M
ollama pull embeddinggemma
~~~

如需免提唤醒，从 [Vosk 官方模型页](https://alphacephei.com/vosk/models) 下载并解压所用语言的模型到上述 `models` 目录。中文用 `vosk-model-small-cn-0.22`，英语用 `vosk-model-small-en-us-0.15`。解压后保留模型目录名。模型缺失时仍可点击麦克风或使用键盘。

在 server.cjs 所在目录运行 `node server.cjs`，打开 `http://localhost:8765/#assist`。团队仓库里服务入口在 web/，Agent 在 llm/。电脑启动页面后，去 Judge view 生成两路配对码。手机走现有 HTTPS 启动方式。电脑若通过证书域名打开 Dashboard，启动时将 `VISIONASSIST_DASHBOARD_HOST` 设为该主机名（不含协议和端口）。同一电脑可直接用 localhost，不需要设置此变量。

Ollama 需要在本机 127.0.0.1:11434 运行。建议在启动 Ollama 的环境设 `OLLAMA_NO_CLOUD=1`。Agent 只连接该回环地址，并使用明确的本地模型名。Whisper 运行时只读取本地模型。可选环境变量如下。

| 变量 | 用途 |
|---|---|
| `VISIONASSIST_PYTHON` | Python 可执行文件路径。默认优先用 Agent 同目录的 .venv |
| `VISIONASSIST_MODELS` | Vosk、Whisper、Piper 与 OpenCV 模型目录。默认是 Agent 同目录的 models |
| `VISIONASSIST_STT_MODEL` | 另一份本地 faster-whisper 模型目录，或已缓存的模型名 |
| `VISIONASSIST_CHAT_MODEL`、`VISIONASSIST_VISION_MODEL` | 本地 Ollama 模型名 |
| `VISIONASSIST_EMBED_MODEL` | 语义记忆使用的本地 Ollama 嵌入模型，默认为 embeddinggemma |
| `VISIONASSIST_DB` | 单用户 SQLite 文件路径。默认位于 Agent 同目录 .visionassist/ |

### GPU

有 NVIDIA 显卡时，转写和实时 OCR 会优先使用 GPU，缺运行库时自动回退 CPU。

| 组件 | 需要的额外依赖 |
|---|---|
| faster-whisper | `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*`。首次 CUDA 失败后，本次进程固定改用 CPU |
| PaddleOCR | 安装 GPU 版 `paddlepaddle-gpu` |

Ollama 自动使用 GPU。Piper 留在 CPU：短告警合成约 0.15 秒，CUDA 版 ONNX Runtime 的预热反而多出数秒。Vosk 唤醒词只在 CPU 上运行。

## Dashboard 演示流程

### 免手操作

用户授权麦克风并开始语音对话后，可以直接说出以下操作。

| 操作 | 示例 |
|---|---|
| 登记与确认 | 「登记物品：水杯」→ 等助手播报 →「确认」或「取消」 |
| 转写审核 | 「开启转写确认」。助手读出转写后说「发送转写」或「丢弃转写」 |
| 相机 | 「切到左边」「比较两路画面」「生成相机 B 的配对码」「再读一遍配对码」「关闭配对窗口」 |
| USB 相机 | 支持 USB 的部署可说「刷新 USB 设备」「把 USB 相机 A 选第一个」「USB 相机设为 1080」「连接 USB 相机」 |
| 管理记忆 | 「读出已保存的物品」「查看水杯的历史记录」「把物品水杯改名为蓝杯」「删除物品蓝杯」。改名和删除都要确认 |
| 设置与播报 | 「回答简短点」「相机上线时提醒我检查钥匙」「提醒间隔设为十五分钟」「再读一遍」「停止播报」「取消请求」「导出对话」「结束对话」 |

浏览器麦克风权限和手机相机权限仍由用户在设备上授权。配对码播报后不会加入导出的对话记录。

桌面顶部的 **YOLO** 显示工作进程上报的设备和精度。**Agent** 显示当前加载的文字或视觉模型及显存比例。看图模型可能在回答后卸载，此时可看 **Last observed**。**Idle** 表示项目使用的模型当前未加载。

视觉问答默认使用 `qwen3-vl:2b-instruct-q4_K_M`。启动 Dashboard 前可用 `VISIONASSIST_VISION_MODEL` 指定其他本地视觉模型。

| 操作 | 示例 |
|---|---|
| 普通对话 | 输入「你好」，或点一次麦克风开启连续对话。每句话后停顿约一秒，等它回答后继续说。再次点击麦克风或按 Esc 结束 |
| 语音设置 | 默认双相机、跟随设备通过浏览器提供的首选语言，其他语言使用自动识别。可说「只看左边」「只看右边」「恢复双相机」「切换到中文」或「语言跟随系统」。左侧是 Camera A，右侧是 Camera B |
| 语音纠错 | 中文转写显示为简体。说「开启转写确认」或在 Voice controls and settings 开启，转写完成后会展开 Keyboard input。可以改字再点 Ask，也可以说「关闭转写确认」 |
| 对话导出 | 右侧 Conversation 显示当前标签页的对话，刷新后仍可查看。说「导出对话」或点 Export Word 下载 .docx |
| YOLO 场景问答 | 选 Camera A，问「我前面有什么？」。根据相机画面和 CV 检测结果显示左右或中央 |
| 单帧看图 | 对准清楚的目标，问「桌上的盒子是什么颜色？」 |
| 双相机看图 | 配对两路相机后选择 Both cameras，点击 Compare cameras，或问「两个画面有什么不同？」。两张新鲜帧按相机分别送入 Qwen，由模型比较视角中的内容 |
| 保存习惯 | 「记住，我出门前要检查钥匙」→ 点击确认或说「确认」→「出门前要记得做什么？」 |
| 登记物品 | 将一个物品放在中心，「这个水杯是我的」→ 确认。可以换角度以相同名称补充样本。之后问「我的水杯在哪里？」 |
| 登记和识别亲友 | 当事人同意后，让对方正对镜头，「登记亲友 小林，哥哥」→ 确认。换角度补充样本。之后主动问「这是谁？」匹配镜头里的脸，或问「小林是谁？」查关系。识别只在询问时运行 |
| 管理记忆 | 在 Saved memory 里编辑或删除条目，通过 History 查看物品可能出现的时间与画面方位 |
| 设置主动提醒 | 先确认保存一条习惯，再从 Saved memory 的下拉列表选中它并保存偏好。Dashboard 发现从无可用相机到有新帧时会提醒一次 |
| 回复长度 | 在 Saved memory 中保存 Prefer brief replies，设置会在重启后保留 |

物品首版使用 YOLO 类别和同帧裁剪的空间 HSV 特征匹配，适合外观有区分的物品。特征匹配有分数和分差门槛。单一候选接近匹配门槛时，先询问用户确认，再写入观察历史。记录历史的时机是用户查询并得到一次匹配时，历史表示当时的可能匹配、画面方位和时间。对同一相机同一帧重复查询只记一条，Dashboard 显示最近 20 条。亲友模板经用户确认后才持久化，只存本地。多张脸、低质量或候选分差过小时会提示无法确认。

## LLM 进阶功能

| 功能 | Dashboard 示例 |
|---|---|
| 习惯建议 | 说「我通常出门前检查钥匙」或「I usually check my keys」。助手会建议保存。也可以在同一会话中两次报告「我今天出门前检查了钥匙」。两次报告至少间隔一分钟，才会出现保存建议。只有确认后才写入本地记忆 |
| 个性化提醒 | 在 Reply and reminder preferences 选择回答长度、已保存习惯和最短提醒间隔。Voice assistant 页面中，检测到从无可用相机变为至少一台相机在线时，按设置播报提醒。障碍警报可以打断普通提醒 |
| 多步骤任务 | 说「一步步教我整理书包」或「Plan pack my backpack」。助手逐步读出计划，说「下一步」「重复这一步」或「取消计划」控制进度。计划保留在当前会话 |
| 语义记忆 | 说「查找记忆：出门要带什么」或「Search memory leaving home」。助手用本机 Ollama 生成文本向量，从 SQLite 中按相似度检索已经保存的习惯和物品，每次最多返回三条。删除一条记录时会删除其向量 |
| 唤醒词 | 在 Voice controls and settings 点击 Enable wake word，授权麦克风。按当前语言说「你好，视觉助手」或「Hey VisionAssist」，可紧接一句命令。待机只用本地 Vosk 检查唤醒词，命中后才交给 Whisper。空闲 15 秒或结束对话后恢复待机。关闭免提或离开页面会释放麦克风 |
| 桌面告警 | CV 告警在 Dashboard 显示。Test warning audio 只播放一次测试短句。第一阶段桌面关闭由画面自动触发的声音，行走告警需要新的路线冲突判断 |
| 本地运行 | 下载并准备模型后，将 Ollama 以 `OLLAMA_NO_CLOUD=1` 启动。关闭外网连接并保留本地网络，验证文本对话、VLM、语音和记忆。手机相机连接仍需要能访问电脑的本地网络 |

运行 `node --test llm/agent.test.cjs web/pairing.test.cjs` 验证 API、任务进度、确认式习惯保存、重启后记忆和偏好、提醒冷却以及现有 CV 对接。自动化测试使用替代模型响应。真机验证时先安装实际模型，再使用上表中的语句。

## CV 联调

手机按所选画质上传标准 JPEG 或原始像素 PNG。CV 可以用 Python 从同一电脑的回环地址获取对应图像，再发布同帧结果。服务器使用实收时间验证新鲜度，结果失效后停止为当前画面提供回答。示例检测从未进入 Agent。启动 Dashboard 后才会提供可用的 CV 数据源。

1. `GET /api/cv/sources` 返回已配对且帧仍新鲜的 `sources`。每项包括 `source_id`、`camera_id` 和 `frame_id`。
2. `GET /api/cv/frame?source_id=...&camera_id=A` 按实际格式返回 JPEG 或 PNG，格式由 `Content-Type` 标识。响应头 `X-CV-Stream-Id` 标识本次配对，重新配对时会更换。`X-CV-Frame-Ms` 是服务器收到该帧的毫秒时间戳。用本次响应 `ETag` 去掉外层引号以获得真实 `frame_id`。用 `If-None-Match` 可以避免重复推理。返回 204 表示暂时没帧，304 表示帧没变。
3. `POST /api/cv/detections?source_id=...&camera_id=A` 提交同帧检测，一次提交完整结果。坐标归一化到 0–1，顺序 `[x1, y1, x2, y2]`，方位为 `left / center / right`。没有检测到物体时提交空数组。

~~~json
{
  "frame_id": "<GET /api/cv/frame 返回的 ETag 去掉引号>",
  "objects": [
    {
      "label": "bottle",
      "position": "center",
      "confidence": 0.94,
      "bbox": [0.42, 0.26, 0.61, 0.81],
      "track_id": "A-21",
      "relative_depth": "unknown",
      "risk": "normal"
    }
  ]
}
~~~

`relative_depth` 比较同一相机同一帧内可比较的物体。取值为 `near`（较近）、`far`（较远）或 `unknown`（无法判断）。缺少此字段或值无法识别时按 `unknown` 处理。在 Agent 选择一台相机后可询问“哪个物体更近？”。

结果过期、相机重配或提交了比当前结果更早的帧时返回 409，这时取新帧再推理。先按相机独立处理。后续若切换 WebRTC，复用这套数据契约，把 JPEG 适配到 WebRTC 后端的帧缓存即可。

CV 可在物体结果中设置 `risk: "caution"` 或 `"urgent"`。Dashboard 轮询新事件，停止正在播报的普通语音后播报固定警示。警示生成绕开 Ollama。紧急警报可打断普通语音，并可在冷却期间打断普通注意警报。相机重配或断开后，旧警报失效。当前是可控场景提醒，画面方位与设备佩戴方向需现场确认。默认 worker 发布 A 的检测和分级风险；添加 `--dual-yolo` 可同时检测 B。

## 测试

运行 `node --test pairing.test.cjs agent.test.cjs`。团队目录结构下，从仓库根目录运行 `node --test web/pairing.test.cjs llm/agent.test.cjs`。自动测试使用双端 HTTP 配对、真实 SQLite、模拟模型和模拟 CV 数据；模型质量、双机与扬声器由现场测试确认。建议先拿一种物品和一位同意登记的亲友试跑，再加入相似物品和未登记参与者。

参考：[Ollama 图片接口](https://docs.ollama.com/capabilities/vision) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [Piper](https://github.com/OHF-Voice/piper1-gpl) · [OpenCV 人脸模型](https://docs.opencv.org/4.x/d0/dd4/tutorial_dnn_face.html)

## 固定 OCR 结果语音演示

从仓库根目录启动服务前，在 PowerShell 执行 `$env:VISIONASSIST_OCR_DEMO = '1'`，再按下文启动网页服务。使用手机时，按 Web README 配置 HTTPS。配对并选中有实时画面的相机 A 或 B，进入助手页面，说 “Help me identify the text.”。助手会显示并播报演示提示和固定文字 `Study Room G17`。也可以输入同一句话，再点 **Read aloud**。语音输入和播报分别使用已安装的 Whisper 和 Piper 模型。

演示结束后执行 `Remove-Item Env:VISIONASSIST_OCR_DEMO` 并重启服务。该演示的文字与镜头内容无关。

## 实时文字识别

在 `llm` 目录运行 `conda env create -f environment.yml`，并把上面列出的 Whisper 和 Piper 模型放入 `llm/models`。Whisper 也支持把对应的 `Systran/faster-whisper-base` 文件放到 `llm/models/whisper-base`。

在 `web` 目录用 Node.js 24 运行 `npm ci` 后，从仓库根目录启动本地开发服务：

~~~powershell
conda activate visionassist-ocr
$env:VISIONASSIST_PYTHON = (Get-Command python).Source
Remove-Item Env:VISIONASSIST_OCR_DEMO -ErrorAction SilentlyContinue
npm --prefix web run dev
~~~

如果模型已下载到另一个工作区，启动前可用 `VISIONASSIST_MODELS` 指向现有模型目录。手机通过 WebRTC 传输时，仍需按 Web README 配置 HTTPS 和 `VISIONASSIST_RTC_PYTHON`。

配对并选择有实时画面的相机，然后询问 “Help me identify the text.” 或“请帮我读一下门牌”。也可以点击 Quick Actions 中的同名按钮。PaddleOCR 从画面中提取文字，Agent 将文字交给本地 Ollama 的聊天模型，然后由 Piper 播报。实时朗读需要 Ollama 在 `127.0.0.1:11434` 运行，并安装默认聊天模型 `qwen3:4b-instruct-2507-q4_K_M` 或 `VISIONASSIST_CHAT_MODEL` 指定的本地模型。Agent 只接受模型对空白的调整，避免模型改写文字或门牌号。Ollama 调用失败时会提示检查本地模型。首次识别时加载 PP-OCRv5 移动版模型，后续识别复用同一进程。

可将 `PP-OCRv5_mobile_det` 和 `PP-OCRv5_mobile_rec` 的 `inference.json`、`inference.pdiparams` 和 `inference.yml` 分别下载到 `llm/models/ocr/` 下的同名子目录。没有预置模型时，PaddleOCR 会尝试下载。识别超时后可以重新发起请求。[检测模型](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det) · [识别模型](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec)

当画面过期、相机重连、没有文字、文字不清或识别超时时，助手会给出对应提示。普通朗读只读置信度达到 `0.80` 的文字，部分内容看不清时会在播报中说明。明确询问“门牌号”“房间号”或 “room number” 时，`Gxx` 候选须在同一相机、同一次请求内两张间隔不超过两秒的画面上读到相同编号才会播报。
