# S1 审查记录 · 2026-11-21

单图和实时入口均从权重识别任务。默认使用 `yolo11n.pt`。调用方通过
`return_masks=True` 获取与物体顺序相同的原图布尔掩码。掩码通过独立返回值留在
Python 内存中。供后续阶段使用的腐蚀和膨胀函数默认采用半径 2 px 和 4 px 的椭圆核。

## MPS 单帧耗时

Apple M1 Pro，PyTorch 2.9.0，Ultralytics 8.4.0。取交接录像
`turn-20261120-175451` 的前 37 张 Camera A 原图，480 × 640。每种模型预热
10 帧，再对 37 帧各跑 3 轮。两种模型逐帧交替先后顺序，各有 111 次计时。
沿用实时 worker 的 FP32、640 输入、置信度 0.25、IoU 0.7、最多 40 个物体和
4 个 PyTorch CPU 线程。计时前后显式同步 MPS，范围从已解码图像进入
`detect()` 到得到物体列表，分割还包括返回全部 CPU 布尔掩码。图像解码、双目、
形态学和网络传输在计时范围外。

| 每帧耗时 | 中位数 | P95 |
| --- | ---: | ---: |
| YOLO11n 检测 | 24.95 ms | 46.17 ms |
| YOLO11n-seg 检测并提取掩码 | 34.12 ms | 55.92 ms |
| 两种模型各自分位数的差 | +9.17 ms | +9.75 ms |

若以中位耗时差衡量，增量低于 12 ms。逐对计算同一帧同一轮的耗时差，
中位数为 8.00 ms，P95 为 22.48 ms，111 对中有 79 对增量 ≤12 ms。
该录像的分割模型每帧有 17–26 个实例。样本只覆盖这一段桌面场景。

原生 MPS 逐实例裁剪的首次对照中，中位增量为 34.67 ms。试用 CPU 解码后为
12.47 ms。最终方案保留原生缩放与插值，把取整后的所有检测框在 GPU 上一次裁剪。
将 37 帧录像和一张不同尺寸的公交照片与原生 MPS 输出对照，38 张图共
769 个实例的物体顺序、检测字段及每个掩码像素均一致。

## 兼容性与复现

用纯检测权重在 CPU 上跑同一批 37 帧，逐帧物体列表与计划基线 `aa011af`
完全一致。关闭道路预警时，两种权重都通过真实本机检测接口提交了公交图的结果，
请求中无掩码，Agent 都能读出公交车。S1 的测试覆盖原图坐标、空检测、
物体与掩码顺序、带填充输入的批量裁剪与空掩码过滤，以及形态学默认半径。

最终 Python CV 74/74、Web 21/21、生产前端 3/3 通过，生产构建及独立
TypeScript 检查通过。首次构建遇到旧 webpack 缓存引用失效路径，保留缓存备份后
重新构建成功。完整 CV 日志含环境中 OpenCV 与 PyAV 自带 FFmpeg 的重复类警告。

从仓库根目录复跑。权重下载方法见 [CV README](../../README.md)。

```sh
PYTHONPATH=cv .visionassist/rtc-env/bin/python cv/results/segmentation-s1/benchmark.py \
  .visionassist/video-analysis/turn-20261120-175451 .visionassist/seg-eval/s1-rerun
PYTHONPATH=cv .visionassist/rtc-env/bin/python -m unittest discover -v -s cv -p 'test_*.py'
(cd web && npm run build -- --webpack && npm test && npm run typecheck && npm run test:frontend)
```

[逐帧原始计时](per-frame.csv) 随代码提交。本机完整日志及早期对照保存在
[`.visionassist/seg-eval/s1-20261121/`](../../../.visionassist/seg-eval/s1-20261121/)。
