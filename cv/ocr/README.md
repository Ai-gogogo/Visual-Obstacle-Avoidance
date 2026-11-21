# 室内标牌时序 OCR

`cv/ocr` 回放 PaddleOCR 的逐帧 JSON，跟踪文字区域并输出多帧确认的标牌。该模块独立于实时 CV、Web 和 Agent。方向字段表示对画面中的印刷文字和布局的解读，不能作为已核实的导航指令。

## 回放与评估

从仓库根目录运行。回放和测试只依赖 Python 3.11 标准库。

```powershell
python -B -m unittest discover -s cv/ocr/tests -v
python -B -m cv.ocr.replay_signs --input-json cv/ocr/tests/example-signs.json --output-json "$env:TEMP/ocr-signs.json"
python -B -m cv.ocr.evaluate_signs --report "$env:TEMP/ocr-signs.json" --labels cv/ocr/tests/example-signs-labels.csv --clip-id synthetic
```

输入沿用 `frames[].time_seconds` 和 `frames[].detections[]`。每条检测包含 `text`、`confidence` 和四点像素坐标 `polygon`。可以通过 `image_size: [width, height]` 或 `--image-size WIDTH HEIGHT` 提供尺寸。未提供尺寸时保留像素坐标，`bbox_normalized` 为 `null`。每帧可带 `camera_id` 和 `stream_id`。相机独立跟踪，同一相机更换流时清空历史。缺失或无效的多边形、无效时间戳以及重复时间戳会被跳过并记录原因。

对于已知的自习室门牌，使用 `--legacy-gxx` 只回放该楼宇的 `Gxx` 门牌。该模式复用原门牌解析规则，并在诊断中保留修正前的文字。默认通用模式保留未知类别和原始用词。

需要重新从视频抽帧时，在独立的 Windows Python 3.11 环境安装 `requirements-ocr.txt`，或复用已有 `visionassist-ocr` 环境。`--models` 指向包含 `PP-OCRv5_mobile_det` 和 `PP-OCRv5_mobile_rec` 的模型目录。采样器在 CPU 上运行并关闭 MKL-DNN。

```powershell
python -m pip install -r cv/ocr/requirements-ocr.txt
python -B -m cv.ocr.paddle_video 录像.mp4 --step 1 --models 模型目录 --out "$env:TEMP/ocr-raw.json"
```

## 确认与空间关联

- 默认在四秒窗口内用两张不同帧确认普通文字，最低单帧置信度为 `0.60`，最低平均置信度为 `0.75`。方向和出入口文字默认要求三帧及平均置信度 `0.85`。近似匹配只用于较长文本，保留否定、左右和 `ONLY` 等关键字。窗口内的有效文字不一致时，输出 `uncertain_sign`。
- 轨迹使用重叠、预测位置、文字相似度和时间差做一对一匹配。移动到另一位置的同名标牌可以独立确认。短时遮挡时保留轨迹，超过 2.5 秒后标记丢失并重新分配 ID。连续可见的同一内容只确认一次，同一轨迹的不同内容设十秒冷却。
- 多行按纵向顺序和水平对齐分组。方向文字只有在与上方目的地行形成唯一对齐时才关联。多列或有多个合理候选时保留不同的行，关系标记为 `unknown`。目前只识别印刷的方向文字。
- `events` 记录标牌及各行 ID、支持帧数、置信度、位置和关系。`frames` 记录区域出现、遮挡和丢失，以及多边形、中心、方向角、跳过原因和分组状态。只消费 `status: confirmed` 的事件可得到已满足时序门槛的结果。

## 验证记录

| 数据 | 观察结果 |
| --- | --- |
| `1480529635.mp4`，真实 PaddleOCR 重新抽取 33 帧 | `G01`、`G02`、`G03`、`G04` 各确认一次，确认时间为 6、14、21、32 秒。 |
| `987418851.mp4`，回放已有的 40 帧识别 JSON | `G17`、`G16`、`G15`、`G14`、`G13` 各确认一次，确认时间为 3、10、23、29、38 秒。 |
| 三帧合成标牌 JSON 和同内容的合成视频 | `BOOK DROP`、`STAFF ONLY`、`EXIT` 及两组厕所方向均确认，5 个标牌、2 个方向对应，零重复。 |

33 帧真实抽取约 20.4 秒，离线融合约 2 毫秒。融合计时不含解码和推理。评估 CLI 使用独立 CSV 标注和视频时间计算事件精确率、召回率、重复数、确认延迟以及方向关联统计。对同时出现的同名标牌，应在 `bbox_or_polygon` 中标注像素框或四点多边形以消除歧义。通用室内实拍、额外未见视频以及逐帧 CER/WER 和轨迹切换率尚待标注和验证。
