# S3 审查记录 · 2026-11-21

基线为 S2 提交 `389b9a8`。S3 验证物体轮廓能否在排除前景及其深度飞点的同时，保留椅腿之间等区域的有效深度，以及多出的点能否帮助支撑平面通过验证。

有实例掩码时，前景沿轮廓向外膨胀 4 px。先合并轮廓再膨胀一次，像素结果等同于逐个膨胀后合并。同一份背景结果供支撑面拟合、PnP 筛选和未知凸起去重使用。支撑面候选保留 `dining table`。纯检测模式沿用各路径原来的矩形扣除规则。测距和测高继续使用 S2 的腐蚀、回退和原始公制深度规则。

## 复现

从仓库根目录运行。每组评测读取 0–36 号同步帧，逐帧计算一次原始 RAFT-Stereo 深度。基线使用 `yolo11n.pt`，实验使用 `yolo11n-seg.pt`，两者各自追踪检测到的物体。YOLO 在 Apple MPS 上运行，掩码后处理和 RAFT 在 CPU 上运行。

```sh
.visionassist/rtc-env/bin/python cv/eval_plane_ransac.py \
  .visionassist/video-analysis/turn-20261120-175451 \
  --calibration cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json \
  --segmentation-comparison --device mps --last-pair 36 --run-id s3-20261121-cup-union
.visionassist/rtc-env/bin/python cv/eval_plane_ransac.py \
  .visionassist/recordings/fefa1fc5-4ebc-4c38-b167-3da82152ca4d \
  --segmentation-comparison --device mps --last-pair 36 --run-id s3-20261121-indoor-union
```

运行 ID 对应新建的本机输出目录。重跑时使用新的 ID。每组输出 `summary.json`、`per-frame.csv`、`per-object.csv` 及逐帧并排叠加图。红色表示前景被排除的像素，绿色表示拟合内点，黄色表示通过误差阈值的留区点。拒绝帧也保留候选拟合，图上标注失败原因。

测距率和测高率各以本管线通过置信度门槛的检测数为分母。高度稳定性为各管线中至少有两次有效高度的轨迹内标准差，再取轨迹间中位数。两种权重的检测和轨迹有差异，且实拍没有逐目标真值。另把分割模型的检测框固定，比较相同检测下的可用深度点数，单独量出轮廓对候选点的影响。

## 同源结果

留区 P90 先逐帧计算，再取有读数帧的中位数，包含未通过的拟合。训练内点和网格数为逐帧均值。

| 指标 | 桌面 bbox | 桌面 mask | 室内 bbox | 室内 mask |
| --- | ---: | ---: | ---: | ---: |
| 平面通过帧 | 22/37 | 19/37 | 0/37 | 0/37 |
| 训练内点 | 8,321 | 9,486 | 13,736 | 15,492 |
| 覆盖网格 | 18.00 | 21.68 | 16.35 | 19.08 |
| 留区 P90 中位数 | 15.3 mm | 16.8 mm | 1,259.4 mm | 1,116.6 mm |
| 有效测距 | 106/379（28.0%） | 111/359（30.9%） | 131/210（62.4%） | 129/197（65.5%） |
| 有效测高 | 162/379（42.7%） | 137/359（38.2%） | 0/210 | 0/197 |
| 轨迹内高度标准差的中位数 | 98.4 mm（14 条） | 58.2 mm（18 条） | 无 | 无 |
| 前景扣除均值 / P95 | 0.20 / 0.42 ms | 0.53 / 0.77 ms | 0.14 / 0.34 ms | 0.44 / 0.61 ms |
| CPU 后处理均值 / P95 | 1.29 / 2.33 ms | 2.78 / 4.31 ms | 0.39 / 0.59 ms | 1.21 / 1.57 ms |
| 检测、后处理、拟合均值 / P95 | 54.52 / 57.51 ms | 71.69 / 75.45 ms | 52.84 / 54.10 ms | 67.70 / 70.02 ms |

固定分割模型的检测框时，改用轮廓扣除平均每帧多保留 2,482 个桌面段有效候选深度点和 15,094 个室内段有效候选深度点。桌面段有 1 帧从失败变通过，有 4 帧从通过变失败。室内段两条管线的 37 帧均因内点比例不足被拒绝。更多候选点有时属于不同表面。原有验证门槛照常生效。

CPU 后处理计入前景扣除、轮廓采样、回退和距离/高度统计。双目重建、YOLO、RANSAC 与输出图像单独计时。实验组比基线的前景扣除 P95 多 0.35 ms（桌面）和 0.27 ms（室内）。桌面段完整 CPU 后处理 P95 为 4.31 ms，高于 4 ms 目标。合并膨胀和逐轮廓局部膨胀在两段录像上得到相同的逐帧拟合指标及逐物体读数。

## 审查文件

- Python CV 82/82、Web 21/21、生产前端 3/3 通过。生产构建及 TypeScript 检查通过。
- 实拍帧 0000 的三次 HTTP 回放均返回 204。S2 和 S3 的纯检测请求均为 33,308 字节，去掉三项上传相关帧号和时间戳后逐字段一致。S3 分割请求逐级检查无像素掩码，原始深度生成的预览也与 S2 一致。
- 桌面段 [汇总](../../../.visionassist/seg-eval/s3-20261121-cup-union/summary.json)、[逐帧](../../../.visionassist/seg-eval/s3-20261121-cup-union/per-frame.csv)、[帧 0007 由失败变通过](../../../.visionassist/seg-eval/s3-20261121-cup-union/overlay/0007-bbox-vs-mask.jpg)、[帧 0020 由通过变失败](../../../.visionassist/seg-eval/s3-20261121-cup-union/overlay/0020-bbox-vs-mask.jpg)
- 室内段 [汇总](../../../.visionassist/seg-eval/s3-20261121-indoor-union/summary.json)、[逐帧](../../../.visionassist/seg-eval/s3-20261121-indoor-union/per-frame.csv)、[帧 0028 两路均未通过](../../../.visionassist/seg-eval/s3-20261121-indoor-union/overlay/0028-bbox-vs-mask.jpg)
- [本机审查日志目录](../../../.visionassist/seg-eval/s3-20261121-review/)
