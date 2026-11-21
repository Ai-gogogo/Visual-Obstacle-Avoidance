# S5 最终审查记录 · 2026-11-21

基线为 S4 提交 `63597b9`。Agent 的 CV 接收路由在检测与深度同帧、Camera B 配对有效时接收最近距离。它要求有限正数且不大于中位距离。未知凸起沿用平面验证门槛，类别限制为 Cityscapes 八个静态类或 `unknown`，有效类别的投票占比须在 0.50–1.00 内。检测发布、预览和 Agent 使用的检测记录由同一接收路由生成。

预览只在检测帧与可用深度帧对应、配对仍有效时返回最近距离和未知凸起。Camera B 断联、配对信息不符、深度过期或只有缓存深度时，预览会清除这两项。控制台更换深度设置时也清理旧数据。

- **Show meters** 开启后，检测框显示中位距离与可用离面高度。P10 同时比中位距离近至少 0.20 m 和 15% 时才追加 `min`。
- **Show plane overlay** 开启后，深度状态区显示同帧最近三个已分类的凸起及其距离。关闭时该行隐藏。

## 验收

- 配对端到端回归覆盖有效和非法标量、掩码字段过滤、错配帧、断联、深度过期和条件请求。前端测试覆盖生产 HTML 中调试摘要默认隐藏，以及运行时开关、近距门槛和错帧回退。
- 使用真实 YOLO 分割权重、Cityscapes 模型和同一对同步录像帧的未滤波 RAFT 深度回放。worker 请求返回 HTTP 204，预览的深度帧 ID 与检测帧 ID 相同，收到 0.585 m 和 0.392 m 两条 P10 及六个凸起记录。断开 Camera B 后依然收到 YOLO 检测，最近距离、凸起记录和深度帧 ID 已清除。递归核验实际检测请求与匹配帧的预览响应，仅出现已知结构化数组，没有实例掩码和 `semantic_map`。另向接收路由注入嵌套掩码字段，验证响应不会回传。
- Python CV 85/85、Web 21/21、生产前端 3/3 通过，生产构建与 TypeScript 检查通过。生产前端在临时本机端口验收。

从仓库根目录复现：

```sh
PYTHONPATH=cv .visionassist/rtc-env/bin/python -m unittest discover -s cv -p "test_*.py"
(cd web && npm run build -- --webpack && npm test && npm run typecheck && npm run test:frontend)
```

[全量回归日志、实拍回放与 HTTP 样本](../../../.visionassist/seg-eval/s5-20261121-review/)。
