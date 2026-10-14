// Rodrigo AI — T6: ícone na barra de menus, atalho global e painel flutuante.
// Sem dependências além do macOS. O painel carrega SÓ http://127.0.0.1:PORT (mesma origem do app: Host/Origin e token
// por sessão continuam valendo). Não lê nem escreve a área de transferência, não persiste a conversa, sem ferramentas
// de depuração. Navegação para qualquer outra origem é bloqueada.
import Cocoa
import WebKit
import Carbon.HIToolbox

let info = Bundle.main.infoDictionary ?? [:]
let repoRoot = (info["RodrigoRepoRoot"] as? String) ?? FileManager.default.currentDirectoryPath
let nodePath = (info["RodrigoNodePath"] as? String) ?? "/opt/homebrew/bin/node"
let port = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? (info["RodrigoPort"] as? Int) ?? 3000
let origin = "http://127.0.0.1:\(port)"
let debugLog = ProcessInfo.processInfo.environment["RODRIGO_DESKTOP_DEBUG"] == "1"
func dlog(_ s: String) { if debugLog { FileHandle.standardError.write(Data(("[desktop] " + s + "\n").utf8)) } }

final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { (NSApp.delegate as? AppDelegate)?.hidePanel() } // Esc fecha e devolve o foco
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var status: NSStatusItem!
    var panel: Panel!
    var web: WKWebView!
    var server: Process?
    var hotKeyRef: EventHotKeyRef?
    var previousApp: NSRunningApplication?   // quem estava na frente antes de abrir o painel (o foco volta para ele)
    var keyTime: Date?                        // carimbo da tecla/clique que pediu abrir
    let showOnStart = ProcessInfo.processInfo.environment["RODRIGO_DESKTOP_SHOW"] == "1"

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildStatusItem()
        registerHotKey()
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
            b.target = self; b.action = #selector(togglePanel)
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
            DispatchQueue.main.async { d.togglePanel() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        let id = EventHotKeyID(signature: OSType(0x52414931), id: 1)
        let st = RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | shiftKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
        dlog("RegisterEventHotKey status=\(st)")
        if st != noErr { NSLog("Rodrigo AI: atalho ⌘⇧Espaço indisponível (status \(st)); use o ícone da barra de menus.") }
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
