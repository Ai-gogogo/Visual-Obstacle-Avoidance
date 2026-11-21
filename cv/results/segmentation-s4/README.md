# S4 审查记录 · 2026-11-21

基线为 S3 提交 `133c615`。启用 `--road-alerts` 和支撑平面且有双目深度时，Camera A 从一次 Cityscapes SegFormer-B0 ONNX 推理得到原有的道路、人行道掩码，以及与原图对齐的静态结构 ID 图。道路与人行道继续按原逻辑对概率做插值，再应用置信度门槛。静态 ID 在模型输出网格上按最高类别概率筛选，再用最近邻扩到原图，避免插值混合类别编号。有效 ID 为 2–9，低置信度和其他类别使用 255。缺少双目深度时沿用原来的路沿路径。

未知凸起仍先按原有的走廊和面积规则筛选。每个连通域只统计其自身的有效语义像素，至少要有 12 个。得票占比达到 50% 时输出类别，并将得票占比四舍五入到两位小数。同票时沿用编号较小的类别。证据不足时输出 `unknown`，省略置信度。未启用道路推理时，沿用 S3 的输出字段。完整 ID 图只留在 worker 内存，HTTP 请求只增加类别和占比两个标量字段。

## 验证

- 合成墙面与柱子验证了连通域投票、50% 和 12 像素边界、洞内像素排除、低置信度和三类混合的回退。真实 Cityscapes ONNX 测试确认道路与人行道掩码逐像素等同于原接口。
- 使用同一对实拍帧和同一份未滤波 RAFT 深度，经临时本机服务实际回放。S3 和 S4 关闭道路推理时均为 0 次 Cityscapes ONNX 调用，去掉上传标识后的 HTTP 请求逐字段一致。S4 开启道路推理时为 1 次 ONNX 调用，请求包含一个 `building` 标签与三个 `unknown`，三次均返回 HTTP 204。这帧没有物理语义标注。得票占比表示区域内语义一致性。
- Python CV 85/85、Web 21/21、生产前端 3/3 通过。生产构建与 TypeScript 检查通过。测试日志和回放请求保存在 [本机审查目录](../../../.visionassist/seg-eval/s4-20261121-review/)。

## CPU 投票耗时

480 × 640 的确定性合成帧。每个场景先通过真实连通域和走廊路径取得测试区域，预热后独立计时 1,200 次。每次累加一帧内所有连通域的像素提取、类别筛选、计数及置信度生成。ONNX 推理、ID 图缩放和几何计算在计时范围外。

| 每帧连通域 | 每帧参与取样像素 | 均值 | 中位数 | P95 |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 2,400 | 0.0198 ms | 0.0189 ms | 0.0223 ms |
| 12 | 14,400 | 0.1281 ms | 0.1246 ms | 0.1452 ms |

从仓库根目录复现：

```sh
PYTHONPATH=cv .visionassist/rtc-env/bin/python cv/results/segmentation-s4/benchmark.py /tmp/s4-vote-cpu.csv
PYTHONPATH=cv .visionassist/rtc-env/bin/python -m unittest discover -s cv -p 'test_*.py' -v
(cd web && npm run build -- --webpack && npm test && npm run typecheck && npm run test:frontend)
```
