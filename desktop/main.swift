// Rodrigo AI — T6: ícone na barra de menus, atalho global e painel flutuante.
// Sem dependências além do macOS. O painel carrega SÓ http://127.0.0.1:PORT (mesma origem do app: Host/Origin e token
// por sessão continuam valendo). Não lê nem escreve a área de transferência, não persiste a conversa, sem ferramentas
// de depuração. Navegação para qualquer outra origem é bloqueada.
import Cocoa
import WebKit
import Carbon.HIToolbox
import AVFoundation
import Network
import ApplicationServices

let info = Bundle.main.infoDictionary ?? [:]
let repoRoot = (info["RodrigoRepoRoot"] as? String) ?? FileManager.default.currentDirectoryPath
let nodePath = (info["RodrigoNodePath"] as? String) ?? "/opt/homebrew/bin/node"
let port = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? (info["RodrigoPort"] as? Int) ?? 3000
let origin = "http://127.0.0.1:\(port)"
let debugLog = ProcessInfo.processInfo.environment["RODRIGO_DESKTOP_DEBUG"] == "1"
func dlog(_ s: String) { if debugLog { FileHandle.standardError.write(Data(("[desktop] " + s + "\n").utf8)) } }

// MARK: - Clipboard paste (DitadoLocal ClipboardPaster) no processo com Acessibilidade

/// Cola texto no app em foco via clipboard + Cmd+V sintético (CGEvent HID).
/// Roda DENTRO do RodrigoAI.app — o processo que já tem Acessibilidade liberada.
enum NativeClipboardPaster {
    static func paste(_ text: String) {
        let pasteboard = NSPasteboard.general
        let previousItems = snapshotCurrentItems()
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        let ourChangeCount = pasteboard.changeCount
        postSyntheticCommandV()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            guard pasteboard.changeCount == ourChangeCount else { return }
            pasteboard.clearContents()
            if !previousItems.isEmpty {
                pasteboard.writeObjects(previousItems)
            }
        }
    }

    private static func snapshotCurrentItems() -> [NSPasteboardItem] {
        let pasteboard = NSPasteboard.general
        return pasteboard.pasteboardItems?.compactMap { item -> NSPasteboardItem? in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    copy.setData(data, forType: type)
                }
            }
            return copy
        } ?? []
    }

    private static func postSyntheticCommandV() {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return }
        let vKeyCode: CGKeyCode = 9 // kVK_ANSI_V
        guard
            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: true),
            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: false)
        else { return }
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }
}

/// Ponte loopback: o Node (filho) pede paste ao processo nativo via HTTP em 127.0.0.1.
/// Só aceita Bearer token; interface restrita a `.loopback`.
final class NativePasteBridge {
    static let shared = NativePasteBridge()
    private(set) var token = UUID().uuidString
    private(set) var port: UInt16 = 0
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "local.rodrigo-ai.native-bridge")
    private(set) var lastExternalApp: NSRunningApplication?
    private var workspaceObserver: NSObjectProtocol?

    private var bridgeInfoURL: URL {
        URL(fileURLWithPath: repoRoot).appendingPathComponent(".runtime/native-bridge.json")
    }

    func recordExternalApp(_ app: NSRunningApplication?) {
        guard let app, app != NSRunningApplication.current, !app.isTerminated else { return }
        if app.bundleIdentifier == "local.rodrigo-ai.desktop" { return }
        lastExternalApp = app
    }

    func start() {
        if let front = NSWorkspace.shared.frontmostApplication, front != NSRunningApplication.current {
            recordExternalApp(front)
        }
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
                self?.recordExternalApp(app)
            }
        }
        do {
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true
            let listener = try NWListener(using: params, on: .any)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] conn in
                self?.handle(conn)
            }
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    if let p = listener.port?.rawValue {
                        self.port = p
                        self.writeBridgeInfo()
                        dlog("native-bridge pronto em 127.0.0.1:\(p)")
                    }
                case .failed(let err):
                    dlog("native-bridge falhou: \(err)")
                default:
                    break
                }
            }
            listener.start(queue: queue)
        } catch {
            dlog("native-bridge não iniciou: \(error)")
        }
    }

    func stop() {
        if let obs = workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(obs)
            workspaceObserver = nil
        }
        listener?.cancel()
        listener = nil
        try? FileManager.default.removeItem(at: bridgeInfoURL)
    }

    private func writeBridgeInfo() {
        let dir = bridgeInfoURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "port": Int(port),
            "token": token,
            "pid": ProcessInfo.processInfo.processIdentifier
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) {
            try? data.write(to: bridgeInfoURL, options: .atomic)
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                dlog("native-bridge recv: \(error)")
                connection.cancel()
                return
            }
            var buf = buffer
            if let data, !data.isEmpty { buf.append(data) }
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = buf.subdata(in: buf.startIndex..<range.lowerBound)
                let header = String(data: headerData, encoding: .utf8) ?? ""
                let rest = buf.subdata(in: range.upperBound..<buf.endIndex)
                let contentLength = Self.contentLength(from: header) ?? 0
                if rest.count >= contentLength {
                    let body = rest.prefix(contentLength)
                    self.serve(header: header, body: Data(body), on: connection)
                    return
                }
            }
            if isComplete {
                connection.cancel()
                return
            }
            self.receive(on: connection, buffer: buf)
        }
    }

    private func resolveTargetExternalApp(requestedBundleId: String?) -> NSRunningApplication? {
        if let bId = requestedBundleId, !bId.isEmpty, bId != "local.rodrigo-ai.desktop" {
            if let match = NSRunningApplication.runningApplications(withBundleIdentifier: bId).first(where: { !$0.isTerminated }) {
                return match
            }
        }
        if let front = NSWorkspace.shared.frontmostApplication,
           front != NSRunningApplication.current,
           front.bundleIdentifier != "local.rodrigo-ai.desktop",
           !front.isTerminated {
            return front
        }
        if let prev = (NSApp.delegate as? AppDelegate)?.previousApp, !prev.isTerminated, prev != NSRunningApplication.current {
            return prev
        }
        if let last = lastExternalApp, !last.isTerminated, last != NSRunningApplication.current {
            return last
        }
        return nil
    }

    private func serve(header: String, body: Data, on connection: NWConnection) {
        let firstLine = header.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let authorized = header.range(of: "Authorization: Bearer \(token)", options: .caseInsensitive) != nil
        guard authorized else {
            respond(connection, status: 401, json: #"{"ok":false,"error":"unauthorized"}"#)
            return
        }
        if firstLine.hasPrefix("GET /frontmost") {
            var bundleId = ""
            var name = ""
            let sem = DispatchSemaphore(value: 0)
            DispatchQueue.main.async {
                if let app = self.resolveTargetExternalApp(requestedBundleId: nil) {
                    bundleId = app.bundleIdentifier ?? ""
                    name = app.localizedName ?? bundleId
                } else if let front = NSWorkspace.shared.frontmostApplication {
                    bundleId = front.bundleIdentifier ?? ""
                    name = front.localizedName ?? bundleId
                }
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + 2)
            let respObj: [String: Any] = ["ok": !bundleId.isEmpty, "bundleId": bundleId, "name": name]
            let respJson = (try? JSONSerialization.data(withJSONObject: respObj)).flatMap { String(data: $0, encoding: .utf8) } ?? #"{"ok":false}"#
            respond(connection, status: 200, json: respJson)
            return
        }
        guard firstLine.hasPrefix("POST /paste") else {
            respond(connection, status: 400, json: #"{"ok":false,"error":"unknown route"}"#)
            return
        }
        var text = ""
        var targetBundleId: String? = nil
        if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let t = obj["text"] as? String { text = t }
            if let b = obj["bundleId"] as? String, !b.isEmpty { targetBundleId = b }
        }
        guard !text.isEmpty else {
            respond(connection, status: 400, json: #"{"ok":false,"error":"empty text"}"#)
            return
        }
        // CGEvent e pasteboard no main thread. Se o painel do Rodrigo AI estiver na frente,
        // devolve o foco ao aplicativo onde estava o cursor antes de disparar Cmd+V.
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            let currentFront = NSWorkspace.shared.frontmostApplication
            let targetApp = self.resolveTargetExternalApp(requestedBundleId: targetBundleId)
            let needsActivate = targetApp != nil && (
                currentFront == NSRunningApplication.current ||
                currentFront?.bundleIdentifier == "local.rodrigo-ai.desktop" ||
                (targetBundleId != nil && currentFront?.bundleIdentifier != targetBundleId)
            )
            if let targetApp, needsActivate {
                targetApp.activate(options: [])
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    NativeClipboardPaster.paste(text)
                    sem.signal()
                }
            } else {
                NativeClipboardPaster.paste(text)
                sem.signal()
            }
        }
        _ = sem.wait(timeout: .now() + 3)
        respond(connection, status: 200, json: #"{"ok":true,"strategy":"native-cgevent"}"#)
    }

    private func respond(_ connection: NWConnection, status: Int, json: String) {
        let reason = status == 200 ? "OK" : (status == 401 ? "Unauthorized" : "Bad Request")
        let body = Data(json.utf8)
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var packet = Data(head.utf8)
        packet.append(body)
        connection.send(content: packet, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func contentLength(from header: String) -> Int? {
        for line in header.split(separator: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: true)
            guard parts.count == 2, parts[0].lowercased() == "content-length" else { continue }
            return Int(parts[1].trimmingCharacters(in: .whitespaces))
        }
        return nil
    }
}

// MARK: - Floating Desktop Icon

enum IconState: String {
    case idle = "idle"
    case listening = "ouvindo"
    case processing = "processando"
    case speaking = "falando"
    case muted = "mutado"
}

final class FloatingIconView: NSView {
    var iconState: IconState = .idle {
        didSet {
            if iconState != oldValue {
                DispatchQueue.main.async { self.transitionTo(self.iconState) }
            }
        }
    }

    private let discSz: CGFloat = 52
    private let glowPad: CGFloat = 8
    private let glowRing = CALayer()
    private let disc = CAGradientLayer()
    private var bars: [CALayer] = []
    private let barRest: [CGFloat] = [11, 19, 11]

    private let cIdle1 = NSColor(red: 0.31, green: 0.275, blue: 0.90, alpha: 1)
    private let cIdle2 = NSColor(red: 0.486, green: 0.228, blue: 0.93, alpha: 1)

    private let cListen1 = NSColor(red: 0.05, green: 0.50, blue: 0.95, alpha: 1)
    private let cListen2 = NSColor(red: 0.10, green: 0.75, blue: 1.00, alpha: 1)

    private let cProc1 = NSColor(red: 0.55, green: 0.20, blue: 0.90, alpha: 1)
    private let cProc2 = NSColor(red: 0.85, green: 0.25, blue: 0.80, alpha: 1)

    private let cSpeak1 = NSColor(red: 0.05, green: 0.70, blue: 0.50, alpha: 1)
    private let cSpeak2 = NSColor(red: 0.15, green: 0.85, blue: 0.60, alpha: 1)

    private let cMute1 = NSColor(red: 0.90, green: 0.35, blue: 0.15, alpha: 1)
    private let cMute2 = NSColor(red: 0.95, green: 0.20, blue: 0.20, alpha: 1)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer!.backgroundColor = NSColor.clear.cgColor
        setupLayers()
        breathe()
        popIn()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func setupLayers() {
        let cx = bounds.midX, cy = bounds.midY
        let gs = discSz + glowPad * 2
        glowRing.frame = CGRect(x: cx - gs / 2, y: cy - gs / 2, width: gs, height: gs)
        glowRing.cornerRadius = gs / 2
        glowRing.backgroundColor = cIdle1.withAlphaComponent(0.2).cgColor
        layer!.addSublayer(glowRing)

        disc.frame = CGRect(x: cx - discSz / 2, y: cy - discSz / 2, width: discSz, height: discSz)
        disc.cornerRadius = discSz / 2
        disc.colors = [cIdle1.cgColor, cIdle2.cgColor]
        disc.startPoint = CGPoint(x: 0, y: 1); disc.endPoint = CGPoint(x: 1, y: 0)
        disc.shadowColor = cIdle1.cgColor; disc.shadowRadius = 10
        disc.shadowOpacity = 0.45; disc.shadowOffset = CGSize(width: 0, height: -2)
        layer!.addSublayer(disc)

        let bw: CGFloat = 3.5, gap: CGFloat = 5
        let tw = 3 * bw + 2 * gap, x0 = (discSz - tw) / 2
        for i in 0..<3 {
            let b = CALayer()
            b.bounds = CGRect(x: 0, y: 0, width: bw, height: barRest[i])
            b.position = CGPoint(x: x0 + CGFloat(i) * (bw + gap) + bw / 2, y: discSz / 2)
            b.cornerRadius = bw / 2
            b.backgroundColor = NSColor.white.withAlphaComponent(0.93).cgColor
            disc.addSublayer(b); bars.append(b)
        }
    }

    private func popIn() {
        layer!.transform = CATransform3DMakeScale(0.01, 0.01, 1)
        let a = CASpringAnimation(keyPath: "transform.scale")
        a.fromValue = 0.01; a.toValue = 1.0
        a.damping = 13; a.stiffness = 180; a.mass = 0.8
        a.duration = a.settlingDuration; a.isRemovedOnCompletion = true
        layer!.add(a, forKey: "popIn"); layer!.transform = CATransform3DIdentity
    }

    private func breathe() {
        glowRing.removeAllAnimations()
        bars.forEach { $0.removeAllAnimations() }
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.35)
        disc.colors = [cIdle1.cgColor, cIdle2.cgColor]
        disc.shadowColor = cIdle1.cgColor
        glowRing.backgroundColor = cIdle1.withAlphaComponent(0.2).cgColor
        for (i, b) in bars.enumerated() {
            b.bounds.size.height = barRest[i]
            b.backgroundColor = NSColor.white.withAlphaComponent(0.93).cgColor
        }
        CATransaction.commit()

        let s = CABasicAnimation(keyPath: "transform.scale")
        s.fromValue = 0.88; s.toValue = 1.14; s.duration = 2.8
        s.autoreverses = true; s.repeatCount = .infinity
        s.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(s, forKey: "breathe")
        let o = CABasicAnimation(keyPath: "opacity")
        o.fromValue = 0.2; o.toValue = 0.6; o.duration = 2.8
        o.autoreverses = true; o.repeatCount = .infinity
        o.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(o, forKey: "glow")
    }

    private func listenAnim() {
        glowRing.removeAllAnimations()
        bars.forEach { $0.removeAllAnimations() }
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        disc.colors = [cListen1.cgColor, cListen2.cgColor]
        disc.shadowColor = cListen1.cgColor
        glowRing.backgroundColor = cListen1.withAlphaComponent(0.4).cgColor
        bars.forEach { $0.backgroundColor = NSColor.white.withAlphaComponent(0.95).cgColor }
        CATransaction.commit()

        let s = CABasicAnimation(keyPath: "transform.scale")
        s.fromValue = 0.94; s.toValue = 1.20; s.duration = 1.2
        s.autoreverses = true; s.repeatCount = .infinity
        s.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(s, forKey: "breathe")
        let o = CABasicAnimation(keyPath: "opacity")
        o.fromValue = 0.35; o.toValue = 0.85; o.duration = 1.2
        o.autoreverses = true; o.repeatCount = .infinity
        s.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(o, forKey: "glow")

        let seqs: [[NSNumber]] = [
            [10, 6, 14, 8, 12, 7, 10], [16, 10, 7, 17, 9, 14, 16], [10, 15, 6, 11, 7, 13, 10]]
        let durs: [CFTimeInterval] = [0.75, 0.85, 0.7]
        for (i, bar) in bars.enumerated() {
            let a = CAKeyframeAnimation(keyPath: "bounds.size.height")
            a.values = seqs[i]; a.duration = durs[i]; a.repeatCount = .infinity
            a.calculationMode = .cubic
            bar.add(a, forKey: "bounce")
        }
    }

    private func processAnim() {
        glowRing.removeAllAnimations()
        bars.forEach { $0.removeAllAnimations() }
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        disc.colors = [cProc1.cgColor, cProc2.cgColor]
        disc.shadowColor = cProc1.cgColor
        glowRing.backgroundColor = cProc1.withAlphaComponent(0.45).cgColor
        CATransaction.commit()

        let s = CABasicAnimation(keyPath: "transform.scale")
        s.fromValue = 0.92; s.toValue = 1.22; s.duration = 0.65
        s.autoreverses = true; s.repeatCount = .infinity
        s.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(s, forKey: "breathe")

        let seqs: [[NSNumber]] = [
            [6, 14, 20, 14, 6], [14, 20, 6, 20, 14], [20, 14, 6, 14, 20]]
        for (i, bar) in bars.enumerated() {
            let a = CAKeyframeAnimation(keyPath: "bounds.size.height")
            a.values = seqs[i]; a.duration = 0.65; a.repeatCount = .infinity
            a.calculationMode = .cubic
            bar.add(a, forKey: "bounce")
        }
    }

    private func speakAnim() {
        glowRing.removeAllAnimations()
        bars.forEach { $0.removeAllAnimations() }
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        disc.colors = [cSpeak1.cgColor, cSpeak2.cgColor]
        disc.shadowColor = cSpeak1.cgColor
        glowRing.backgroundColor = cSpeak1.withAlphaComponent(0.45).cgColor
        CATransaction.commit()

        let s = CABasicAnimation(keyPath: "transform.scale")
        s.fromValue = 0.95; s.toValue = 1.25; s.duration = 0.8
        s.autoreverses = true; s.repeatCount = .infinity
        glowRing.add(s, forKey: "breathe")

        let seqs: [[NSNumber]] = [
            [12, 6, 20, 8, 16, 7, 12], [24, 12, 8, 22, 10, 18, 24], [14, 20, 8, 16, 9, 18, 14]]
        let durs: [CFTimeInterval] = [0.45, 0.55, 0.42]
        for (i, bar) in bars.enumerated() {
            let a = CAKeyframeAnimation(keyPath: "bounds.size.height")
            a.values = seqs[i]; a.duration = durs[i]; a.repeatCount = .infinity
            a.calculationMode = .cubic
            bar.add(a, forKey: "bounce")
        }
    }

    private func muteAnim() {
        glowRing.removeAllAnimations()
        bars.forEach { $0.removeAllAnimations() }
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.25)
        disc.colors = [cMute1.cgColor, cMute2.cgColor]
        disc.shadowColor = cMute1.cgColor
        glowRing.backgroundColor = cMute1.withAlphaComponent(0.35).cgColor
        for bar in bars {
            bar.bounds.size.height = 3.5
            bar.backgroundColor = NSColor(white: 1.0, alpha: 0.7).cgColor
        }
        CATransaction.commit()

        let o = CABasicAnimation(keyPath: "opacity")
        o.fromValue = 0.3; o.toValue = 0.7; o.duration = 1.8
        o.autoreverses = true; o.repeatCount = .infinity
        glowRing.add(o, forKey: "glow")
    }

    private func transitionTo(_ st: IconState) {
        switch st {
        case .idle: breathe()
        case .listening: listenAnim()
        case .processing: processAnim()
        case .speaking: speakAnim()
        case .muted: muteAnim()
        }
    }

    func pressDown() {
        let a = CABasicAnimation(keyPath: "transform.scale")
        a.toValue = 0.88; a.duration = 0.08
        a.fillMode = .forwards; a.isRemovedOnCompletion = false
        layer!.add(a, forKey: "press")
    }
    func pressUp() {
        layer!.removeAnimation(forKey: "press")
        let a = CASpringAnimation(keyPath: "transform.scale")
        a.fromValue = 0.88; a.toValue = 1.0
        a.damping = 10; a.stiffness = 300; a.mass = 0.5
        a.duration = a.settlingDuration; a.isRemovedOnCompletion = true
        layer!.add(a, forKey: "release")
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self))
    }
    override func mouseEntered(with event: NSEvent) {
        let a = CABasicAnimation(keyPath: "transform.scale")
        a.toValue = 1.1; a.duration = 0.2; a.fillMode = .forwards; a.isRemovedOnCompletion = false
        a.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer!.add(a, forKey: "hover")
    }
    override func mouseExited(with event: NSEvent) { layer!.removeAnimation(forKey: "hover") }
}

final class FloatingIconWindow: NSPanel {
    private var clickOrigin: NSPoint?
    private var frameAtClick: NSPoint?
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func mouseDown(with event: NSEvent) {
        clickOrigin = NSEvent.mouseLocation; frameAtClick = frame.origin
        (contentView as? FloatingIconView)?.pressDown()
    }
    override func mouseDragged(with event: NSEvent) {
        guard let co = clickOrigin, let fo = frameAtClick else { return }
        let now = NSEvent.mouseLocation
        setFrameOrigin(NSPoint(x: fo.x + now.x - co.x, y: fo.y + now.y - co.y))
    }
    override func mouseUp(with event: NSEvent) {
        (contentView as? FloatingIconView)?.pressUp()
        if let co = clickOrigin {
            let now = NSEvent.mouseLocation
            if hypot(now.x - co.x, now.y - co.y) < 4 {
                if event.clickCount >= 2 {
                    (NSApp.delegate as? AppDelegate)?.stopVoice()
                } else {
                    (NSApp.delegate as? AppDelegate)?.handleIconClick()
                }
            }
        }
        clickOrigin = nil; frameAtClick = nil
    }
    override func rightMouseUp(with event: NSEvent) {
        guard let d = NSApp.delegate as? AppDelegate else { return }
        let m = NSMenu()
        if d.isVoiceSessionActive {
            let muteTitle = d.isMuted ? "Reativar microfone" : "Silenciar microfone"
            m.addItem(NSMenuItem(title: muteTitle, action: #selector(AppDelegate.toggleMute), keyEquivalent: "m"))
            m.addItem(NSMenuItem(title: "Encerrar conversa (duplo clique)", action: #selector(AppDelegate.stopVoice), keyEquivalent: "."))
            m.addItem(.separator())
        } else {
            m.addItem(NSMenuItem(title: "Iniciar conversa por voz", action: #selector(AppDelegate.startVoice), keyEquivalent: "v"))
            m.addItem(.separator())
        }
        let spTitle = d.isSpeakerphone ? "Desligar viva-voz" : "Ligar viva-voz"
        m.addItem(NSMenuItem(title: spTitle, action: #selector(AppDelegate.toggleSpeakerphone), keyEquivalent: ""))
        m.addItem(NSMenuItem(title: "Mostrar/ocultar janela (⌘⌥R)", action: #selector(AppDelegate.togglePanel), keyEquivalent: ""))
        m.addItem(NSMenuItem(title: "Recarregar", action: #selector(AppDelegate.reload), keyEquivalent: ""))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "Sair do Rodrigo AI", action: #selector(AppDelegate.quit), keyEquivalent: "q"))
        m.items.forEach { $0.target = d }
        NSMenu.popUpContextMenu(m, with: event, for: contentView!)
    }
}

final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { (NSApp.delegate as? AppDelegate)?.hidePanel() } // Esc fecha e devolve o foco
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var status: NSStatusItem!
    var panel: Panel!
    var web: WKWebView!
    var server: Process?
    var hotKeyRef: EventHotKeyRef?
    var previousApp: NSRunningApplication?   // quem estava na frente antes de abrir o painel (o foco volta para ele)
    var keyTime: Date?                        // carimbo da tecla/clique que pediu abrir
    let showOnStart = ProcessInfo.processInfo.environment["RODRIGO_DESKTOP_SHOW"] == "1"
    var floatingIcon: FloatingIconWindow!
    var iconView: FloatingIconView!

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // Ponte de paste no processo com Acessibilidade — sobe antes do Node.
        NativePasteBridge.shared.start()
        buildPanel()
        buildStatusItem()
        registerHotKey()
        buildFloatingIcon()
        requestAccessibilityIfNeeded()
        requestAutomationIfNeeded()
        requestMicrophoneIfNeeded()
        // O servidor sobe em segundo plano (pode levar segundos): a interface nunca fica bloqueada esperando por ele.
        DispatchQueue.global(qos: .userInitiated).async {
            self.startServerIfNeeded()
            DispatchQueue.main.async {
                self.web.load(URLRequest(url: URL(string: origin)!))
                if self.showOnStart { self.showPanel() }
                if debugLog { DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.probe() } }
            }
        }
    }

    private func requestAccessibilityIfNeeded() {
        let trustedNow = AXIsProcessTrusted()
        dlog("launch accessibilityTrusted=\(trustedNow)")
        guard !trustedNow else { return }

        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            if !AXIsProcessTrusted() {
                self.openPrivacyPane("Privacy_Accessibility")
            }
        }
    }

    private func requestAutomationIfNeeded() {
        DispatchQueue.global(qos: .utility).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = [
                "-e",
                "tell application id \"com.apple.systemevents\" to return name of first application process whose frontmost is true"
            ]
            let out = Pipe()
            let err = Pipe()
            p.standardOutput = out
            p.standardError = err
            do {
                try p.run()
                p.waitUntilExit()
                guard p.terminationStatus != 0 else { return }
                let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                guard stderr.contains("-1743") || stderr.localizedCaseInsensitiveContains("not authorized to send Apple events") else {
                    return
                }
                dlog("Automação para System Events ainda não concedida: \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
                DispatchQueue.main.async {
                    self.openPrivacyPane("Privacy_Automation")
                }
            } catch {
                dlog("falha ao checar Automação: \(error)")
            }
        }
    }

    private func requestMicrophoneIfNeeded() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        dlog("launch micPermissão=\(status.rawValue)")
        switch status {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                dlog("launch micConcedido=\(granted)")
                if !granted {
                    DispatchQueue.main.async {
                        self.openPrivacyPane("Privacy_Microphone")
                    }
                }
            }
        case .denied, .restricted:
            DispatchQueue.main.async {
                self.openPrivacyPane("Privacy_Microphone")
            }
        default:
            break
        }
    }

    private func openPrivacyPane(_ anchor: String) {
        if let deepLink = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)"),
           NSWorkspace.shared.open(deepLink) {
            return
        }
        if let fallback = URL(string: "x-apple.systempreferences:com.apple.preference.security") {
            _ = NSWorkspace.shared.open(fallback)
        }
    }

    func applicationWillTerminate(_ n: Notification) {
        dlog("willTerminate server=\(String(describing: server?.processIdentifier))")
        NativePasteBridge.shared.stop()
        guard let p = server, p.isRunning else {
            if let k = hotKeyRef { UnregisterEventHotKey(k) }
            return
        }
        p.terminate()
        // O servidor pode demorar a encerrar com conexões abertas (SSE/keep-alive): espera um pouco e então força.
        for _ in 0..<20 { if !p.isRunning { break }; Thread.sleep(forTimeInterval: 0.1) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        if let k = hotKeyRef { UnregisterEventHotKey(k) }
    }

    // --- servidor ---
    func healthOK() -> Bool {
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: URL(string: origin + "/api/health")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            if let h = resp as? HTTPURLResponse, h.statusCode == 200, let d = data,
               String(data: d, encoding: .utf8)?.contains("\"status\":\"ok\"") == true { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return ok
    }

    func startServerIfNeeded() {
        // Espera a ponte publicar porta/token (até ~2s) para o Node já nascer com o env certo.
        for _ in 0..<20 {
            if NativePasteBridge.shared.port != 0 { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        if healthOK() {
            dlog("servidor já estava de pé (bridge em .runtime/native-bridge.json)")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = ["dist/server/backend/index.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoRoot)
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port); env["HOST"] = "127.0.0.1"
        env["RODRIGO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier) // o servidor sai sozinho se este app morrer
        if NativePasteBridge.shared.port != 0 {
            env["RODRIGO_NATIVE_BRIDGE_PORT"] = String(NativePasteBridge.shared.port)
            env["RODRIGO_NATIVE_BRIDGE_TOKEN"] = NativePasteBridge.shared.token
        }
        // App gráfico (Launch Services) não herda o PATH do zsh — sem /opt/homebrew/bin o worker
        // não acha `ffmpeg` e a transcrição cai em erro. Prepende os caminhos comuns do Homebrew.
        let brewBins = "/opt/homebrew/bin:/usr/local/bin"
        if let path = env["PATH"], !path.isEmpty {
            env["PATH"] = "\(brewBins):\(path)"
        } else {
            env["PATH"] = "\(brewBins):/usr/bin:/bin:/usr/sbin:/sbin"
        }
        // Um app gráfico não herda o ~/.zshenv: carrega o .env do projeto NÃO é feito aqui (o servidor já lê o .env).
        p.environment = env
        let log = URL(fileURLWithPath: repoRoot).appendingPathComponent(".runtime/desktop-server.log")
        try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let h = try? FileHandle(forWritingTo: log) { p.standardOutput = h; p.standardError = h }
        do { try p.run(); server = p; dlog("servidor iniciado, pid \(p.processIdentifier)") }
        catch { dlog("falha ao iniciar o servidor: \(error)") }
        for _ in 0..<40 { if healthOK() { break }; Thread.sleep(forTimeInterval: 0.25) }
    }

    // --- painel ---
    func buildPanel() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()          // nada da conversa persiste depois do encerramento
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        // Rede: o delegate só vê NAVEGAÇÕES; fetch/XHR/WebSocket/subrecursos passam por aqui. Bloqueia tudo que não seja
        // a origem do app (regra geral de bloqueio + exceção para 127.0.0.1:PORT).
        let rules = """
        [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^http://127\\\\.0\\\\.0\\\\.1:\(port)/"},"action":{"type":"ignore-previous-rules"}},
         {"trigger":{"url-filter":"^ws://127\\\\.0\\\\.0\\\\.1:\(port)/"},"action":{"type":"ignore-previous-rules"}}]
        """
        let sem = DispatchSemaphore(value: 0)
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "rodrigo-loopback-only", encodedContentRuleList: rules) { list, err in
            if let l = list { cfg.userContentController.add(l) } else { NSLog("Rodrigo AI: regra de rede não compilou: \(String(describing: err))") }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 5)
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.add(self, name: "iconState")
        cfg.userContentController.add(self, name: "consoleLog")
        cfg.userContentController.add(self, name: "closePanel")
        cfg.userContentController.add(self, name: "minimizePanel")
        cfg.userContentController.add(self, name: "speakerphoneGet")
        cfg.userContentController.add(self, name: "speakerphoneSet")
        // Persistência fora do WKWebsiteDataStore.nonPersistent (localStorage morre a cada reload).
        let spOn = UserDefaults.standard.bool(forKey: "rodrigo.voice.speakerphone")
        let spScript = WKUserScript(
            source: "window.__speakerphoneInitial = '\(spOn ? "1" : "0")';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        cfg.userContentController.addUserScript(spScript)
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = false }
        let w: CGFloat = 420, h: CGFloat = 560
        panel = Panel(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .nonactivatingPanel, .fullSizeContentView],
                      backing: .buffered, defer: false)
        panel.title = "Orque — Rodrigo AI"
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = web
        // O WKWebView consome o Esc antes de ele chegar ao painel (cancelOperation não dispara): captura aqui.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53, let self = self, self.panel.isKeyWindow { self.hidePanel(); return nil }
            if e.keyCode == 46 && e.modifierFlags.contains(.command), let self = self, self.panel.isKeyWindow { self.panel.miniaturize(nil); return nil }
            return e
        }
    }

    func showPanel() {
        let me = NSRunningApplication.current
        if let front = NSWorkspace.shared.frontmostApplication, front != me {
            previousApp = front
            NativePasteBridge.shared.recordExternalApp(front)
        }
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.maxX - panel.frame.width - 16, y: f.maxY - panel.frame.height - 8))
        }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        recordUsage(visibleAt: Date())
        if debugLog {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.web.evaluateJavaScript("document.hasFocus()") { r, _ in
                    dlog("foco: appAtiva=\(NSApp.isActive) painelKey=\(self.panel.isKeyWindow) paginaFoco=\(String(describing: r)) frente=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")")
                }
            }
        }
    }
    func hidePanel() {
        panel.orderOut(nil)
        if let p = previousApp, !p.isTerminated { p.activate(options: []) }   // devolve o foco ao app anterior
        if debugLog {
            let anterior = previousApp?.localizedName ?? "?"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                dlog("foco após fechar: frente=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?") (esperado: \(anterior))")
            }
        }
        previousApp = nil
    }
    @objc func togglePanel() {
        if panel.isMiniaturized {
            panel.deminiaturize(nil)
            showPanel()
        } else if panel.isVisible {
            hidePanel()
        } else {
            keyTime = Date()
            showPanel()
        }
    }

    /// Contador local de uso (plano §3.6): só dois carimbos de tempo por abertura. NENHUM conteúdo, nenhum nome de app.
    func recordUsage(visibleAt: Date) {
        guard let k = keyTime else { return }
        keyTime = nil
        let line = "{\"ts\":\"\(ISO8601DateFormatter().string(from: k))\",\"keyToVisibleMs\":\(Int(visibleAt.timeIntervalSince(k) * 1000))}\n"
        dlog("uso: \(line.trimmingCharacters(in: .whitespacesAndNewlines))")
        let url = URL(fileURLWithPath: repoRoot).appendingPathComponent(".runtime/desktop-usage.jsonl")
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? Data(line.utf8).write(to: url) }
    }

    // --- ícone da barra de menus ---
    func buildStatusItem() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = status.button {
            b.image = NSImage(systemSymbolName: "waveform.circle", accessibilityDescription: "Rodrigo AI")
            b.image?.isTemplate = true
            b.target = self; b.action = #selector(toggleVoice)
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Mostrar/ocultar (⌘⌥R)", action: #selector(togglePanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Recarregar painel", action: #selector(reload), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Sair", action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        // clique esquerdo alterna; menu fica no clique direito
        let rightMenu = menu
        NSEvent.addLocalMonitorForEvents(matching: [.rightMouseUp]) { [weak self] e in
            if let btn = self?.status.button, e.window == btn.window { self?.status.menu = rightMenu; btn.performClick(nil); self?.status.menu = nil; return nil }
            return e
        }
    }
    @objc func reload() { web.load(URLRequest(url: URL(string: origin)!)) }
    @objc func quit() { NSApp.terminate(nil) }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hidePanel()
        return false
    }

    // --- atalho global (Carbon: não pede permissão de Acessibilidade) ---
    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, ud in
            let d = Unmanaged<AppDelegate>.fromOpaque(ud!).takeUnretainedValue()
            DispatchQueue.main.async { d.togglePanel() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        let id = EventHotKeyID(signature: OSType(0x52414931), id: 1)
        let st = RegisterEventHotKey(UInt32(kVK_ANSI_R), UInt32(cmdKey | optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
        dlog("RegisterEventHotKey status=\(st)")
        if st != noErr { NSLog("Rodrigo AI: atalho ⌘⌥R indisponível (status \(st)); use o ícone da barra de menus.") }
    }

    // --- voz via ícone flutuante e atalho ---
    var isVoiceSessionActive: Bool { voiceActive }
    var isMuted: Bool = false
    var isSpeakerphone: Bool { UserDefaults.standard.bool(forKey: "rodrigo.voice.speakerphone") }
    private var voiceActive = false

    @objc func handleIconClick() {
        if voiceActive {
            toggleMute()
        } else {
            startVoice()
        }
    }

    @objc func toggleVoice() {
        handleIconClick()
    }

    @objc func startVoice() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        dlog("startVoice micPermissão=\(status.rawValue)")
        switch status {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                dlog("startVoice micConcedido=\(granted)")
                if granted { DispatchQueue.main.async { self?.startVoiceViaWeb() } }
                else {
                    DispatchQueue.main.async {
                        let a = NSAlert()
                        a.messageText = "Rodrigo AI"
                        a.informativeText = "Permita o acesso ao microfone em Ajustes do Sistema → Privacidade e Segurança → Microfone."
                        a.alertStyle = .warning
                        a.addButton(withTitle: "Abrir Ajustes")
                        a.addButton(withTitle: "Cancelar")
                        let response = a.runModal()
                        if response == .alertFirstButtonReturn {
                            self?.openPrivacyPane("Privacy_Microphone")
                        }
                    }
                }
            }
        case .denied, .restricted:
            let a = NSAlert()
            a.messageText = "Rodrigo AI"
            a.informativeText = "Acesso ao microfone negado. Abra Ajustes do Sistema → Privacidade e Segurança → Microfone e ative o Rodrigo AI."
            a.alertStyle = .warning
            a.addButton(withTitle: "Abrir Ajustes")
            a.addButton(withTitle: "Cancelar")
            let response = a.runModal()
            if response == .alertFirstButtonReturn {
                openPrivacyPane("Privacy_Microphone")
            }
        default:
            startVoiceViaWeb()
        }
    }

    private func startVoiceViaWeb() {
        // WKWebView precisa de janela visível para getUserMedia funcionar no macOS.
        // Posicionamos o painel fora da área visível (nunca aparece para o usuário).
        if !panel.isVisible {
            panel.setFrameOrigin(NSPoint(x: -9999, y: -9999))
            panel.orderFront(nil)
            dlog("startVoice: painel ordenado fora da tela para permitir getUserMedia")
        }
        let js = "return await window.__startVoice();"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let val):
                let r = val as? String ?? "nil"
                dlog("startVoice: \(r)")
                if r.hasPrefix("error:") {
                    self.iconView?.iconState = .idle
                    self.voiceActive = false
                    self.isMuted = false
                    self.panel.orderOut(nil)
                    let msg = String(r.dropFirst(6))
                    dlog("startVoice ERRO: \(msg)")
                    DispatchQueue.main.async {
                        let a = NSAlert()
                        a.messageText = "Rodrigo AI"
                        a.informativeText = msg
                        a.alertStyle = .warning
                        a.addButton(withTitle: "OK")
                        a.runModal()
                    }
                } else if r == "started" || r == "already_active" {
                    self.voiceActive = true
                    self.isMuted = false
                    self.iconView?.iconState = .listening
                    // Painel permanece visível (fora da tela) enquanto voz estiver ativa
                }
            case .failure(let err):
                dlog("startVoice JS falhou: \(err)")
                self.iconView?.iconState = .idle
                self.voiceActive = false
                self.isMuted = false
                self.panel.orderOut(nil)
            }
        }
    }

    @objc func stopVoice() {
        let js = "return await window.__stopVoice();"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            self.voiceActive = false
            self.isMuted = false
            self.iconView?.iconState = .idle
            self.panel.orderOut(nil)
            dlog("stopVoice: \(result)")
        }
    }

    @objc func toggleMute() {
        guard voiceActive else { return }
        let js = "return await window.__toggleMute();"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let val):
                let r = val as? String ?? "nil"
                dlog("toggleMute: \(r)")
                if r == "muted" {
                    self.isMuted = true
                    self.iconView?.iconState = .muted
                } else if r == "unmuted" {
                    self.isMuted = false
                    self.iconView?.iconState = .listening
                }
            case .failure(let err):
                dlog("toggleMute falhou: \(err)")
            }
        }
    }

    @objc func toggleSpeakerphone() {
        let js = "return await window.__toggleSpeakerphone();"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let val):
                dlog("toggleSpeakerphone: \(val as? String ?? "nil")")
            case .failure(let err):
                dlog("toggleSpeakerphone falhou: \(err)")
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "closePanel" {
            DispatchQueue.main.async { [weak self] in self?.hidePanel() }
            return
        }
        if message.name == "minimizePanel" {
            DispatchQueue.main.async { [weak self] in self?.panel.miniaturize(nil) }
            return
        }
        if message.name == "consoleLog", let text = message.body as? String {
            dlog(text)
            return
        }
        if message.name == "speakerphoneSet" {
            let raw: String
            if let dict = message.body as? [String: Any], let v = dict["value"] as? String {
                raw = v
            } else if let s = message.body as? String {
                raw = s
            } else {
                raw = "0"
            }
            let on = (raw == "1" || raw.lowercased() == "true")
            UserDefaults.standard.set(on, forKey: "rodrigo.voice.speakerphone")
            dlog("speakerphoneSet: \(on ? "1" : "0")")
            return
        }
        if message.name == "speakerphoneGet" {
            // O JS já lê window.__speakerphoneInitial; este handler existe para o contrato do plano.
            let on = UserDefaults.standard.bool(forKey: "rodrigo.voice.speakerphone")
            let js = "window.__speakerphoneInitial = '\(on ? "1" : "0")';"
            DispatchQueue.main.async { [weak self] in
                self?.web.evaluateJavaScript(js, completionHandler: nil)
            }
            return
        }
        guard message.name == "iconState", let stateStr = message.body as? String else { return }
        dlog("iconState: \(stateStr)")
        if stateStr == "mutado" {
            isMuted = true
            iconView?.iconState = .muted
            voiceActive = true
            return
        }
        if stateStr == "idle" || stateStr == "erro" {
            voiceActive = false
            isMuted = false
            iconView?.iconState = .idle
            return
        }
        voiceActive = true
        if !isMuted {
            iconView?.iconState = IconState(rawValue: stateStr) ?? .listening
        }
    }

    // --- ícone flutuante ---
    func buildFloatingIcon() {
        let vs: CGFloat = 72
        iconView = FloatingIconView(frame: NSRect(x: 0, y: 0, width: vs, height: vs))
        floatingIcon = FloatingIconWindow(contentRect: NSRect(x: 0, y: 0, width: vs, height: vs),
                                          styleMask: .nonactivatingPanel, backing: .buffered, defer: false)
        floatingIcon.isOpaque = false
        floatingIcon.backgroundColor = .clear
        floatingIcon.level = .floating
        floatingIcon.hasShadow = false
        floatingIcon.hidesOnDeactivate = false
        floatingIcon.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        floatingIcon.isReleasedWhenClosed = false
        floatingIcon.contentView = iconView
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            floatingIcon.setFrameOrigin(NSPoint(x: f.maxX - vs - 24, y: f.minY + 24))
        }
        floatingIcon.orderFrontRegardless()
    }

    // --- só a origem do app ---
    func allowed(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        if u.absoluteString == "about:blank" { return true }
        return u.scheme == "http" && u.host == "127.0.0.1" && u.port == port
    }
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let ok = allowed(a.request.url)
        if !ok { dlog("navegação bloqueada: \(a.request.url?.absoluteString ?? "?")") }
        decisionHandler(ok ? .allow : .cancel)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? { nil }
    // microfone: só para a origem do app
    @available(macOS 12.0, *)
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor o: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let ok = o.protocol == "http" && o.host == "127.0.0.1" && o.port == port && type == .microphone
        dlog("pedido de mídia \(type.rawValue) de \(o.host):\(o.port) -> \(ok ? "permitido" : "negado")")
        decisionHandler(ok ? .grant : .deny)
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) { completionHandler() }

    // --- diagnóstico (só com RODRIGO_DESKTOP_DEBUG=1) ---
    func probe() {
        web.evaluateJavaScript("JSON.stringify({title:document.title,secure:window.isSecureContext,md:typeof navigator.mediaDevices,body:document.body.innerText.slice(0,120)})") { r, e in
            dlog("probe: \(String(describing: r)) erro=\(String(describing: e))")
        }
        // Rede: fetch externo tem de FALHAR; fetch à própria origem tem de funcionar.
        let js = """
        const t = async (u) => { try { const r = await fetch(u, {mode:'no-cors'}); return 'ok' } catch (e) { return 'bloqueado' } };
        return JSON.stringify({externo: await t('http://example.com/'), externoHttps: await t('https://example.com/'), local: await t('\(origin)/api/health')});
        """
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { res in
            dlog("rede: \(res)")
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// SIGTERM/SIGINT encerram de forma limpa (derruba o servidor filho; sem isso ele ficaria órfão).
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let sigSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { NSApp.terminate(nil) }
    src.resume()
    return src
}
_ = sigSources
app.run()
