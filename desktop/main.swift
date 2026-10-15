// Rodrigo AI — T6: ícone na barra de menus, atalho global e painel flutuante.
// Sem dependências além do macOS. O painel carrega SÓ http://127.0.0.1:PORT (mesma origem do app: Host/Origin e token
// por sessão continuam valendo). Não lê nem escreve a área de transferência, não persiste a conversa, sem ferramentas
// de depuração. Navegação para qualquer outra origem é bloqueada.
import Cocoa
import WebKit
import Carbon.HIToolbox
import AVFoundation

let info = Bundle.main.infoDictionary ?? [:]
let repoRoot = (info["RodrigoRepoRoot"] as? String) ?? FileManager.default.currentDirectoryPath
let nodePath = (info["RodrigoNodePath"] as? String) ?? "/opt/homebrew/bin/node"
let port = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? (info["RodrigoPort"] as? Int) ?? 3000
let origin = "http://127.0.0.1:\(port)"
let debugLog = ProcessInfo.processInfo.environment["RODRIGO_DESKTOP_DEBUG"] == "1"
func dlog(_ s: String) { if debugLog { FileHandle.standardError.write(Data(("[desktop] " + s + "\n").utf8)) } }

// MARK: - Floating Desktop Icon

enum IconState { case idle, active }

final class FloatingIconView: NSView {
    var iconState: IconState = .idle { didSet { if iconState != oldValue { transitionTo(iconState) } } }

    private let discSz: CGFloat = 52
    private let glowPad: CGFloat = 8
    private let glowRing = CALayer()
    private let disc = CAGradientLayer()
    private var bars: [CALayer] = []
    private let barRest: [CGFloat] = [11, 19, 11]
    private let c1 = NSColor(red: 0.31, green: 0.275, blue: 0.9, alpha: 1)
    private let c2 = NSColor(red: 0.486, green: 0.228, blue: 0.93, alpha: 1)

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
        glowRing.backgroundColor = c1.withAlphaComponent(0.2).cgColor
        layer!.addSublayer(glowRing)

        disc.frame = CGRect(x: cx - discSz / 2, y: cy - discSz / 2, width: discSz, height: discSz)
        disc.cornerRadius = discSz / 2
        disc.colors = [c1.cgColor, c2.cgColor]
        disc.startPoint = CGPoint(x: 0, y: 1); disc.endPoint = CGPoint(x: 1, y: 0)
        disc.shadowColor = c1.cgColor; disc.shadowRadius = 10
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
        bars.forEach { $0.removeAllAnimations() }
    }

    private func bounce() {
        glowRing.removeAllAnimations()
        let s = CABasicAnimation(keyPath: "transform.scale")
        s.fromValue = 0.94; s.toValue = 1.18; s.duration = 1.0
        s.autoreverses = true; s.repeatCount = .infinity
        s.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(s, forKey: "breathe")
        let o = CABasicAnimation(keyPath: "opacity")
        o.fromValue = 0.35; o.toValue = 0.8; o.duration = 1.0
        o.autoreverses = true; o.repeatCount = .infinity
        o.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowRing.add(o, forKey: "glow")
        let seqs: [[NSNumber]] = [
            [11, 6, 16, 9, 14, 7, 11], [19, 11, 7, 18, 10, 15, 19], [11, 17, 7, 13, 8, 15, 11]]
        let durs: [CFTimeInterval] = [0.55, 0.65, 0.5]
        for (i, bar) in bars.enumerated() {
            let a = CAKeyframeAnimation(keyPath: "bounds.size.height")
            a.values = seqs[i]; a.duration = durs[i]; a.repeatCount = .infinity
            a.calculationMode = .cubic
            bar.add(a, forKey: "bounce")
        }
    }

    private func transitionTo(_ st: IconState) { st == .idle ? breathe() : bounce() }

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
                (NSApp.delegate as? AppDelegate)?.toggleVoice()
            }
        }
        clickOrigin = nil; frameAtClick = nil
    }
    override func rightMouseUp(with event: NSEvent) {
        guard let d = NSApp.delegate as? AppDelegate else { return }
        let m = NSMenu()
        m.addItem(NSMenuItem(title: "Mostrar/ocultar (⌘⇧Espaço)", action: #selector(AppDelegate.togglePanel), keyEquivalent: ""))
        m.addItem(NSMenuItem(title: "Recarregar painel", action: #selector(AppDelegate.reload), keyEquivalent: ""))
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "Sair", action: #selector(AppDelegate.quit), keyEquivalent: "q"))
        m.items.forEach { $0.target = d }
        NSMenu.popUpContextMenu(m, with: event, for: contentView!)
    }
}

final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { (NSApp.delegate as? AppDelegate)?.hidePanel() } // Esc fecha e devolve o foco
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
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
        buildPanel()
        buildStatusItem()
        registerHotKey()
        buildFloatingIcon()
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

    func applicationWillTerminate(_ n: Notification) {
        dlog("willTerminate server=\(String(describing: server?.processIdentifier))")
        guard let p = server, p.isRunning else { return }
        p.terminate()
        // O servidor pode demorar a encerrar com conexões abertas (SSE/keep-alive): espera um pouco e então força.
        for _ in 0..<20 { if !p.isRunning { return }; Thread.sleep(forTimeInterval: 0.1) }
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
        if healthOK() { dlog("servidor já estava de pé"); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = ["dist/server/backend/index.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoRoot)
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port); env["HOST"] = "127.0.0.1"
        env["RODRIGO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier) // o servidor sai sozinho se este app morrer
        // Um app gráfico não herda o ~/.zshenv: carrega o .env do projeto NÃO é feito aqui (o servidor já lê o .env).
        p.environment = env
        let log = URL(fileURLWithPath: repoRoot).appendingPathComponent(".runtime/desktop-server.log")
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
        cfg.userContentController.add(self, name: "iconState")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = false }
        let w: CGFloat = 420, h: CGFloat = 560
        panel = Panel(contentRect: NSRect(x: 0, y: 0, width: w, height: h),
                      styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView],
                      backing: .buffered, defer: false)
        panel.title = "Rodrigo AI"
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.contentView = web
        // O WKWebView consome o Esc antes de ele chegar ao painel (cancelOperation não dispara): captura aqui.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53, let self = self, self.panel.isKeyWindow { self.hidePanel(); return nil }
            return e
        }
    }

    func showPanel() {
        let me = NSRunningApplication.current
        if let front = NSWorkspace.shared.frontmostApplication, front != me { previousApp = front }
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
        if panel.isVisible { hidePanel() } else { keyTime = Date(); showPanel() }
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
        menu.addItem(NSMenuItem(title: "Mostrar/ocultar (⌘⇧Espaço)", action: #selector(togglePanel), keyEquivalent: ""))
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

    // --- atalho global (Carbon: não pede permissão de Acessibilidade) ---
    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, ud in
            let d = Unmanaged<AppDelegate>.fromOpaque(ud!).takeUnretainedValue()
            DispatchQueue.main.async { d.toggleVoice() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        let id = EventHotKeyID(signature: OSType(0x52414931), id: 1)
        let st = RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | shiftKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
        dlog("RegisterEventHotKey status=\(st)")
        if st != noErr { NSLog("Rodrigo AI: atalho ⌘⇧Espaço indisponível (status \(st)); use o ícone da barra de menus.") }
    }

    // --- voz via ícone flutuante ---
    private var voiceActive = false
    @objc func toggleVoice() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        dlog("toggleVoice micPermissão=\(status.rawValue)")
        switch status {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                dlog("toggleVoice micConcedido=\(granted)")
                if granted { DispatchQueue.main.async { self?.startVoiceViaWeb() } }
                else {
                    DispatchQueue.main.async {
                        let a = NSAlert()
                        a.messageText = "Rodrigo AI"
                        a.informativeText = "Permita o acesso ao microfone em Ajustes do Sistema → Privacidade e Segurança → Microfone."
                        a.alertStyle = .warning; a.addButton(withTitle: "OK"); a.runModal()
                    }
                }
            }
        case .denied, .restricted:
            let a = NSAlert()
            a.messageText = "Rodrigo AI"
            a.informativeText = "Acesso ao microfone negado. Abra Ajustes do Sistema → Privacidade e Segurança → Microfone e ative o Rodrigo AI."
            a.alertStyle = .warning; a.addButton(withTitle: "OK"); a.runModal()
        default:
            startVoiceViaWeb()
        }
    }

    private func startVoiceViaWeb() {
        let js = "return await window.__toggleVoice();"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let val):
                let r = val as? String ?? "nil"
                dlog("toggleVoice: \(r)")
                if r.hasPrefix("error:") {
                    self.iconView?.iconState = .idle
                    self.voiceActive = false
                    let msg = String(r.dropFirst(6))
                    dlog("toggleVoice ERRO: \(msg)")
                    DispatchQueue.main.async {
                        let a = NSAlert()
                        a.messageText = "Rodrigo AI"
                        a.informativeText = msg
                        a.alertStyle = .warning
                        a.addButton(withTitle: "OK")
                        a.runModal()
                    }
                } else if r == "started" {
                    self.voiceActive = true
                    self.iconView?.iconState = .active
                } else if r == "stopped" {
                    self.voiceActive = false
                    self.iconView?.iconState = .idle
                } else if r == "busy" {
                    dlog("toggleVoice: busy — resetando estado dos botões")
                    self.web.evaluateJavaScript("""
                        document.getElementById('voice-start-btn').disabled = false;
                        document.getElementById('voice-end-btn').disabled = true;
                    """)
                    self.voiceActive = false
                    self.iconView?.iconState = .idle
                }
            case .failure(let err):
                dlog("toggleVoice JS falhou: \(err)")
                self.iconView?.iconState = .idle
                self.voiceActive = false
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "iconState", let state = message.body as? String else { return }
        dlog("iconState: \(state)")
        let active = state != "idle" && state != "erro"
        voiceActive = active
        iconView?.iconState = active ? .active : .idle
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
