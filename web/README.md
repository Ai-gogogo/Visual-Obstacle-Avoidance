# VisionAssist 桌面与手机相机原型

## 先看设计

- 电脑打开 `http://localhost:8765/`。默认进入 **Judge view**，显示两路示例画面和物体框。配对后进入实时模式，显示 Camera A 的 YOLO 检测、Camera B 和双目深度图。首次测距前需要为当前支架完成双目标定。顶部 **Voice assistant** 切到用户页。
- 手机打开相机路由 `/camera`。首屏显示配对操作。配对、授权并启动相机后，页面显示取景和镜头状态。离开页面会结束采集。原有 `/index.html` 和 `/camera.html` 链接会跳转到对应路由。

## 试实际配对

需要 Node.js 24。前端使用 React、Next.js App Router 和 TypeScript。相机配对和文字记忆使用 Node 内置模块。语音转写、对话和视觉识别的本地模型配置见 [Agent 使用和 CV 联调](../llm/README.md)。

1. 进入本目录，运行 `npm ci` 和 `npm run dev`。在同一台电脑打开 `http://localhost:8765/` 和 `http://localhost:8765/camera`，可以先试双标签页配对。
2. 两台手机实测需要与电脑网络互通，并能访问受信任的 HTTPS 地址。准备证书后，运行 `npm run build`，然后运行 `npm start -- "证书路径.pem" "私钥路径.pem"`。电脑和手机使用证书覆盖的同一主机名和端口。电脑打开根路径，手机打开 `/camera`。证书和私钥请保存在项目目录外。
3. 电脑点击 **Pair a phone**，为 Camera A 生成配对码，在第一台手机输入。第二台手机使用 Camera B 的独立配对码。配对码五分钟有效且只能使用一次。
4. 从 **Voice assistant** 提问、录音、登记和删除记忆。先完成本地模型准备。**Show sample feeds** 是 Judge view 的独立示例。

本地服务用低频 JPEG 帧预览。Agent 的 YOLO 问答和个人物品识别依赖 CV 程序通过本机接口提交同帧检测。Qwen 单帧问答和亲友识别可以读取已经配对的相机帧。Judge view 的样例照片和距离为演示数据。

## 验证接口

运行 `npm test` 检查配对和隔离、过期画面、Agent 接口、同帧检测和 SQLite 持久化。运行 `npm run typecheck` 检查 TypeScript。完成 `npm run build` 后，运行 `npm run test:frontend` 验证生产服务的两个页面、静态资源和同源配对接口。

## 前端分层

| 层 | 入口 |
| --- | --- |
| 设计变量 | `styles/tokens.css` 定义语义色、控件尺寸和动效时长 |
| 通用组件 | `components/` 与 `styles/components.css` |
| 页面布局 | `app/` 提供桌面和手机路由，`styles/layout.css` 负责响应式布局 |
| 功能模块 | `features/` 分开维护语音、对话、记忆、监看、标定、配对和手机采集 |
| 交互与状态 | 手机表单和语音界面使用 React 状态。设备、音频和轮询由带清理逻辑的功能控制器管理。会话请求由 `services/desktop-session.js` 管理 |
| 无障碍与动效 | `shared/accessibility.js`、`styles/motion.css` 与组件的原生表单和公告区域 |

`server.cjs` 在同一端口处理设备、CV 和 Agent 的 `/api/*` 请求，其余请求交给 Next.js。桌面页切换面板时保留同一相机会话。视频帧、检测、深度图和记忆从现有接口按需读取。

使用 Tab 移动焦点，Enter 激活链接和按钮，Escape 关闭弹窗、停止播报或取消当前请求。**Reduce motion** 与系统的减少动态效果设置都能关闭动效。声波只用录音模块提供的真实麦克风 RMS。系统原生选择菜单保留平台交互，150 ms 动效用于页面内展开面板。

显式断开相机时，下一次相机状态轮询就会公告；突然失联时，等待服务判定画面已过期。**Saved memory** 中的历史观察保留相机、时间与位置，回答也会标明来源。

## Camera A 检测与双目深度图

相机配对页的 **Original pixels · lossless PNG** 按浏览器实际采集尺寸上传无损帧，目标节拍为每秒一帧。**Standard** 沿用长边最多 640 px 的 JPEG。实时页默认按帧的宽高比显示，可点 **Actual pixels** 按接收到的像素 1:1 查看。做双目标定时，两台设备应选择相同模式，保持镜头、方向和采集尺寸固定。标定工具可读取保存的 PNG 和 JPEG 帧。

同一控制台配对左右两台手机。Camera A 提供检测画面；Camera B 提供双目匹配所需的另一个视角。控制台读取同一份 `/api/preview/A` 响应中的 JPEG、检测框和深度图，按同一帧一起显示。深度图越亮表示越近，黑色为缺测。B 断开时清除深度图及框上的米数，A 继续更新。运行方法和实机校准步骤见 [CV 说明](../cv/README.md)。
