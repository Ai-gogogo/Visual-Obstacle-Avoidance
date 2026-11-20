import AVFoundation
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Camera", sessionRole: connectingSceneSession.role)
        config.delegateClass = CameraSceneDelegate.self
        return config
    }
}

final class CameraSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let controller = CameraViewController()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        self.window = window
        window.makeKeyAndVisible()
    }

    func sceneDidBecomeActive(_ scene: UIScene) { controller.start() }
    func sceneWillResignActive(_ scene: UIScene) { controller.stop() }
}

final class CameraViewController: UIViewController {
    private let camera = Camera()
    private lazy var server = FrameServer(camera: camera)
    private lazy var preview = AVCaptureVideoPreviewLayer(session: camera.session)
    private let label = UILabel()
    private var cameraStatus = "Waiting for camera"
    private var usbStatus = "Starting USB endpoint"

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview.videoGravity = .resizeAspect
        view.layer.addSublayer(preview)
        label.numberOfLines = 0
        label.textColor = .white
        label.backgroundColor = UIColor.black.withAlphaComponent(0.75)
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        view.addSubview(label)

        camera.status = { [weak self] message in
            DispatchQueue.main.async { self?.cameraStatus = message; self?.refreshLabel() }
        }
        server.status = { [weak self] message in
            DispatchQueue.main.async { self?.usbStatus = message; self?.refreshLabel() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
        if let c = preview.connection, c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
        label.frame = CGRect(x: 0, y: view.safeAreaInsets.top, width: view.bounds.width, height: 88)
    }

    private func refreshLabel() { label.text = "\(cameraStatus)\n\(usbStatus)" }

    func start() {
        UIApplication.shared.isIdleTimerDisabled = true
        server.start()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: camera.start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { _ in
                DispatchQueue.main.async { if self.view.window?.windowScene?.activationState == .foregroundActive { self.start() } }
            }
        default:
            cameraStatus = "Allow camera access in Settings to capture frames"
            refreshLabel()
        }
    }

    func stop() {
        UIApplication.shared.isIdleTimerDisabled = false
        server.stop()
        camera.stop()
    }
}
