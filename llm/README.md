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
ollama pull qwen3-vl:2b
~~~

在 server.cjs 所在目录运行 `node server.cjs`，打开 `http://localhost:8765/#assist`。团队仓库里服务入口在 web/，Agent 在 llm/。电脑启动页面后，去 Judge view 生成两路配对码。手机走现有 HTTPS 启动方式。电脑若通过证书域名打开 Dashboard，启动时将 `VISIONASSIST_DASHBOARD_HOST` 设为该主机名（不含协议和端口）。同一电脑可直接用 localhost，不需要设置此变量。

Ollama 需要在本机 127.0.0.1:11434 运行。建议在启动 Ollama 的环境设 `OLLAMA_NO_CLOUD=1`。Agent 只连接该回环地址，并使用明确的本地模型名。Whisper 运行时只读取本地模型。可选环境变量如下。

| 变量 | 用途 |
|---|---|
| `VISIONASSIST_PYTHON` | Python 可执行文件路径。默认优先用 Agent 同目录的 .venv |
| `VISIONASSIST_MODELS` | Whisper、Piper 与 OpenCV 模型目录。默认是 Agent 同目录的 models |
| `VISIONASSIST_STT_MODEL` | 另一份本地 faster-whisper 模型目录，或已缓存的模型名 |
| `VISIONASSIST_CHAT_MODEL`、`VISIONASSIST_VISION_MODEL` | 本地 Ollama 模型名 |
| `VISIONASSIST_DB` | 单用户 SQLite 文件路径。默认位于 Agent 同目录 .visionassist/ |

## Dashboard 演示流程

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
| 删除记忆 | 在 Saved memory 里选择类型并删除 |

物品首版使用 YOLO 类别和同帧裁剪的空间 HSV 特征匹配，适合外观有区分的物品。特征匹配有分数和分差门槛。记录历史的时机是用户查询并得到一次匹配时，历史表示当时的可能匹配、画面方位和时间。亲友模板经用户确认后才持久化，只存本地。多张脸、低质量或候选分差过小时会提示无法确认。

## CV 联调

当前 VisionAssist 的手机数据入口是本地 JPEG 配对预览。CV 可以用 Python 从同一电脑的回环地址获取 JPEG，再发布同帧结果。服务器使用实收时间验证新鲜度，结果失效后停止为当前画面提供回答。示例检测从未进入 Agent。启动 Dashboard 后才会提供可用的 CV 数据源。

1. `GET /api/cv/sources` 返回已配对且帧仍新鲜的 `sources`。每项包括 `source_id`、`camera_id` 和 `frame_id`。
2. `GET /api/cv/frame?source_id=...&camera_id=A` 返回 JPEG。用本次响应 `ETag` 去掉外层引号以获得真实 `frame_id`。用 `If-None-Match` 可以避免重复推理。返回 204 表示暂时没帧，304 表示帧没变。
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
      "track_id": 21,
      "risk": "normal"
    }
  ]
}
~~~

结果过期、相机重配或提交了比当前结果更早的帧时返回 409，这时取新帧再推理。先按相机独立处理。后续若切换 WebRTC，复用这套数据契约，把 JPEG 适配到 WebRTC 后端的帧缓存即可。

CV 可在物体结果中设置 `risk: "caution"` 或 `"urgent"`。Dashboard 轮询新事件，停止正在播报的普通语音后播报固定警示。警示生成绕开 Ollama。当前是可控场景提醒，画面方位与设备佩戴方向需现场确认。

## 测试

运行 `node --test pairing.test.cjs agent.test.cjs`。团队目录结构下，从仓库根目录运行 `node --test web/pairing.test.cjs llm/agent.test.cjs`。自动测试使用双端 HTTP 配对、真实 SQLite、模拟模型和模拟 CV 数据；模型质量、双机与扬声器由现场测试确认。建议先拿一种物品和一位同意登记的亲友试跑，再加入相似物品和未登记参与者。

参考：[Ollama 图片接口](https://docs.ollama.com/capabilities/vision) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [Piper](https://github.com/OHF-Voice/piper1-gpl) · [OpenCV 人脸模型](https://docs.opencv.org/4.x/d0/dd4/tutorial_dnn_face.html)
