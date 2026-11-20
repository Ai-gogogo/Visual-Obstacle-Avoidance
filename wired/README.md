# 两台 iPhone 通过 USB 实时标定

每台 iPhone 各用一根数据线连到 Mac。采集 App 可输出 1080 × 1920 或 480 × 640 竖屏彩色 PNG，优先使用后置超广角镜头。手机显示实际镜头。两路画面均通过数据线送到 Mac，电脑仪表盘使用本机地址。

1. 解锁两台 iPhone，在手机上允许信任此电脑。手机需要 iOS 17 或更高版本。
2. 在 Mac 打开 [WiredCamera 工程](ios/WiredCamera.xcodeproj)。在 Xcode 选择 WiredCamera target → Signing & Capabilities → Team，选自己的开发团队。在顶部选第一台 iPhone，按运行按钮。按手机提示启用开发者模式并允许相机访问。对第二台重复安装。让两台手机都保持竖屏，并在前台显示 WiredCamera 取景画面。
3. 在 Mac 打开[本地仪表盘](http://localhost:8775/)，点 **Pair a phone**。在 **USB cameras** 里选择 Camera A（左）和 Camera B（右）。本次标定使用 Rice 为 A、Jia 为 B。
4. 在 **Camera output · both phones** 选择两台手机的输出尺寸。480 × 640 使用中心裁切，在手机端缩小后传输。已连接时点 **Apply camera settings**。首次连接点 **Connect USB cameras**，看到 **Both USB cameras are live** 后关闭弹窗即可。若刚刚插线，点 **Refresh devices**。需要停止时，回到同一弹窗点 **Disconnect USB**。
5. 进入 **Stereo calibration** 并选择 **Single face**。把棋盘放到两边都能看到的位置，确认两边出现绿点，再开始录制。

这里的全分辨率指上述视频帧从手机到 Mac 保持原像素尺寸。网页保存的标定视频仍使用已有的视频编码。更换镜头或移动支架后，应为实际机位重新标定，再用独立的桌面视频验证深度。

在 **Stereo depth map → Depth source** 可以选择实时模式或本机保存的低像素深度回放。历史录像用当时机位的标定绘制相对深度。短暂等待计算时，界面会标注上一张深度图的年龄。

本次机位的高、低像素参数保存在 `cv/results/stereo-calibration-2026-11-20/`。从项目根目录启动深度计算：

```sh
python cv/live_camera.py --server http://127.0.0.1:8775 \
  --stereo-config cv/results/stereo-calibration-2026-11-20/usb-1080x1920.json \
  --usb-low-config cv/results/stereo-calibration-2026-11-20/usb-480x640.json
```
