import AVFoundation
import CoreImage
import Foundation

struct Frame {
    let data: Data
    let captureMs: Double
    let low: Bool
    let etag: String
}

final class Camera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    var status: ((String) -> Void)?
    private let queue = DispatchQueue(label: "camera.capture", qos: .userInitiated)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private let lock = NSLock()
    private var latest: Frame?
    private var lens: String?
    private var lastStatus = ""

    private var lowOutput = false

    func frame(low: Bool) -> Frame? {
        lock.withLock {
            lowOutput = low
            return latest?.low == low ? latest : nil
        }
    }

    private func report(_ text: String) {
        if text != lastStatus {
            lastStatus = text
            status?(text)
        }
    }

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted),
            name: AVCaptureSession.wasInterruptedNotification, object: session)
        NotificationCenter.default.addObserver(self, selector: #selector(runtimeError),
            name: AVCaptureSession.runtimeErrorNotification, object: session)
    }

    @objc private func interrupted() {
        queue.async {
            self.lock.withLock { self.latest = nil }
            self.report("Camera interrupted")
        }
    }

    @objc private func runtimeError(_ notification: Notification) {
        let detail = (notification.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription
        queue.async {
            self.lock.withLock { self.latest = nil }
            self.report(detail ?? "Camera error. Reopen the app to retry.")
        }
    }

    func start() {
        queue.async {
            do {
                if self.lens == nil { try self.configure() }
                if !self.session.isRunning { self.session.startRunning() }
            } catch { self.report(error.localizedDescription) }
        }
    }

    func stop() {
        queue.async {
            if self.session.isRunning { self.session.stopRunning() }
            self.lock.withLock { self.latest = nil }
        }
    }

    private func failure(_ text: String) -> NSError {
        NSError(domain: "WiredCamera", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }

    private func configure() throws {
        guard let device = AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        else { throw failure("No rear camera available") }
        guard let format = device.formats.first(where: {
            let size = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return size.width == 1920 && size.height == 1080 && !$0.isVideoBinned &&
                $0.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }
        }) ?? device.formats.first(where: {
            let size = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return size.width == 1920 && size.height == 1080 &&
                $0.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }
        }) else { throw failure("Rear camera has no supported 1920 × 1080 format") }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureVideoDataOutput()
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input) else { throw failure("Cannot add rear camera") }
        session.addInput(input)
        do {
            guard session.canAddOutput(output) else { throw failure("Cannot add camera output") }
            session.addOutput(output)
            try device.lockForConfiguration()
            device.activeFormat = format
            let duration = CMTime(value: 1, timescale: 30)
            device.activeVideoMinFrameDuration = duration
            device.activeVideoMaxFrameDuration = duration
            device.videoZoomFactor = 1
            device.unlockForConfiguration()
            output.automaticallyConfiguresOutputBufferDimensions = false
            output.deliversPreviewSizedOutputBuffers = false
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            guard let connection = output.connection(with: .video),
                  connection.isVideoRotationAngleSupported(90) else { throw failure("Cannot rotate into portrait") }
            connection.videoRotationAngle = 90
            if connection.isVideoStabilizationSupported { connection.preferredVideoStabilizationMode = .off }
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            lens = device.deviceType == .builtInUltraWideCamera ? "Rear ultra wide" : "Rear wide"
            report("\(lens!) · waiting for first frame")
        } catch {
            if session.outputs.contains(output) { session.removeOutput(output) }
            session.removeInput(input)
            throw error
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard session.isRunning, !session.isInterrupted,
              let pixels = CMSampleBufferGetImageBuffer(sample),
              let clock = session.synchronizationClock else { return }
        guard CVPixelBufferGetWidth(pixels) == 1080, CVPixelBufferGetHeight(pixels) == 1920 else {
            lock.withLock { latest = nil }
            report("Unexpected output size · capture paused")
            return
        }
        let pts = CMSyncConvertTime(CMSampleBufferGetPresentationTimeStamp(sample),
                                    from: clock, to: CMClockGetHostTimeClock())
        let ms = pts.seconds * 1000
        guard ms.isFinite else { return }
        autoreleasepool {
            let low = lock.withLock { lowOutput }
            var image = CIImage(cvPixelBuffer: pixels)
            if low {
                // A centered 3:4 crop from the calibrated portrait sensor image.
                image = image.cropped(to: CGRect(x: 0, y: 240, width: 1080, height: 1440))
                    .transformed(by: CGAffineTransform(translationX: 0, y: -240))
                    .transformed(by: CGAffineTransform(scaleX: 4.0/9, y: 4.0/9))
            }
            guard let data = context.pngRepresentation(of: image,
                    format: .RGBA8, colorSpace: colorSpace) else {
                lock.withLock { latest = nil }
                report("PNG encoding failed")
                return
            }
            let frame = Frame(data: data, captureMs: ms, low: low, etag: "\"\(UUID().uuidString)\"")
            lock.withLock { latest = frame }
            report("\(lens ?? "Rear camera") · \(low ? "480 × 640" : "1080 × 1920") PNG")
        }
    }
}
