import CoreMedia
import Foundation
import Network

final class FrameServer {
    private let camera: Camera
    private let queue = DispatchQueue(label: "camera.endpoint")
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    var status: ((String) -> Void)?

    init(camera: Camera) { self.camera = camera }

    func start() {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.listener == nil else { return }
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 18875)
            do {
                let listener = try NWListener(using: parameters)
                self.listener = listener
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self, let listener, self.listener === listener else { return }
                    switch state {
                    case .ready: self.status?("USB ready · port 18875")
                    case .failed(let error):
                        self.status?(error.localizedDescription)
                        listener.cancel()
                        self.listener = nil
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self, weak listener] conn in
                    guard let self, let listener, self.listener === listener else { conn.cancel(); return }
                    self.accept(conn)
                }
                listener.start(queue: self.queue)
            } catch { self.status?(error.localizedDescription) }
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            for conn in self.clients.values { conn.cancel() }
            self.clients.removeAll()
        }
    }

    private func accept(_ conn: NWConnection) {
        guard clients.count < 6 else { conn.cancel(); return }
        let id = ObjectIdentifier(conn)
        clients[id] = conn
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled: self?.clients.removeValue(forKey: id)
            case .failed: self?.clients[id]?.cancel()
            default: break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 10) { [weak conn] in conn?.cancel() }
        read(conn, prefix: Data())
    }

    private func read(_ conn: NWConnection, prefix: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { bytes, _, done, error in
            var request = prefix
            if let bytes { request.append(bytes) }
            guard error == nil, request.count <= 8192 else { conn.cancel(); return }
            if let end = request.range(of: Data("\r\n\r\n".utf8)),
               let head = String(data: request[..<end.lowerBound], encoding: .utf8) {
                self.respond(conn, head: head)
            } else if done { conn.cancel() }
            else { self.read(conn, prefix: request) }
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let lines = head.components(separatedBy: "\r\n")
        let request = lines[0].split(separator: " ")
        guard request.count == 3, request[0] == "GET" else {
            send(conn, "400 Bad Request"); return
        }
        switch request[1] {
        case "/clock":
            let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds * 1000
            send(conn, "200 OK", headers: ["Content-Type": "application/json"],
                 body: Data("{\"clockMs\":\(now)}".utf8))
        case "/frame", "/frame/480x640":
            guard let frame = camera.frame(low: request[1] == "/frame/480x640") else { send(conn, "204 No Content"); return }
            let etagMatches = lines.dropFirst().contains { line in
                let pair = line.split(separator: ":", maxSplits: 1)
                return pair.count == 2 && pair[0].lowercased() == "if-none-match"
                    && pair[1].trimmingCharacters(in: .whitespaces) == frame.etag
            }
            if etagMatches { send(conn, "304 Not Modified", headers: ["ETag": frame.etag]); return }
            send(conn, "200 OK", headers: ["Content-Type": "image/png", "ETag": frame.etag,
                                           "X-Capture-Ms": String(frame.captureMs)], body: frame.data)
        default: send(conn, "404 Not Found")
        }
    }

    private func send(_ conn: NWConnection, _ status: String, headers: [String: String] = [:],
                      body: Data = Data()) {
        var head = "HTTP/1.1 \(status)\r\nConnection: close\r\nCache-Control: no-store\r\n"
        if !status.hasPrefix("204"), !status.hasPrefix("304") { head += "Content-Length: \(body.count)\r\n" }
        for (key, value) in headers { head += "\(key): \(value)\r\n" }
        let header = Data((head + "\r\n").utf8)
        conn.send(content: header, completion: .contentProcessed { error in
            if error != nil || body.isEmpty { conn.cancel(); return }
            conn.send(content: body, completion: .contentProcessed { _ in conn.cancel() })
        })
    }
}
