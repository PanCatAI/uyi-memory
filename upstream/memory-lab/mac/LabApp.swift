// 记忆实验台.app: a native window around the memory lab. It starts the bundled Node server on a free local
// port, shows it in a WKWebView and stops the server when the app quits. Data and keys live in
// ~/Library/Application Support/UYI Memory Lab, so the app does not depend on the source folder.
import Cocoa
import WebKit

let appName = "记忆实验台"
let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/UYI Memory Lab")
let logDir = home.appendingPathComponent("Library/Logs/UYI Memory Lab")
let logFile = logDir.appendingPathComponent("server.log")

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?
  var port = 4340
  var quitting = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = self
    web.navigationDelegate = self
    if #available(macOS 13.3, *) { web.isInspectable = true }
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1600, height: 960), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = appName
    window.contentView = web
    window.minSize = NSSize(width: 900, height: 600)
    window.setFrameAutosaveName("LabMain")
    if !window.setFrameUsingName("LabMain") { window.center() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    showMessage("正在启动记忆实验台…", detail: "")
    DispatchQueue.global().async { self.start() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ note: Notification) {
    quitting = true
    guard let p = server, p.isRunning else { return }
    p.terminate()
    let deadline = Date().addingTimeInterval(3)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
  }

  /* ---------- server ---------- */
  func start() {
    do {
      try fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
      try fm.createDirectory(at: logDir, withIntermediateDirectories: true)
      migrateIfNeeded()
      port = freePort(from: 4340)
      let res = Bundle.main.resourceURL!
      let p = Process()
      p.executableURL = res.appendingPathComponent("node/node")
      p.arguments = [res.appendingPathComponent("app/server.mjs").path]
      p.currentDirectoryURL = res.appendingPathComponent("app")
      p.environment = serverEnvironment()
      fm.createFile(atPath: logFile.path, contents: nil)
      let log = try FileHandle(forWritingTo: logFile)
      p.standardOutput = log
      p.standardError = log
      p.terminationHandler = { [weak self] proc in
        DispatchQueue.main.async {
          guard let self, !self.quitting else { return }
          self.showMessage("本地服务意外退出（代码 \(proc.terminationStatus)）", detail: self.logTail())
        }
      }
      try p.run()
      server = p
      waitUntilReady(deadline: Date().addingTimeInterval(40))
    } catch {
      DispatchQueue.main.async { self.showMessage("启动失败：\(error.localizedDescription)", detail: self.logTail()) }
    }
  }

  /// First launch: copy the API settings (.env) from the source folder recorded at build time. Lab data starts empty.
  func migrateIfNeeded() {
    let env = supportDir.appendingPathComponent(".env")
    guard !fm.fileExists(atPath: env.path) else { return }
    guard let src = Bundle.main.object(forInfoDictionaryKey: "LabSourceDir") as? String, !src.isEmpty else { return }
    let srcEnv = URL(fileURLWithPath: src).appendingPathComponent(".env")
    guard fm.fileExists(atPath: srcEnv.path) else { return }
    try? fm.copyItem(at: srcEnv, to: env)
    try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: env.path)
  }

  func serverEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let extraPath = ["\(home.path)/.local/bin", "\(home.path)/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    env["PATH"] = (extraPath + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
    env["LAB_APP"] = "1"
    env["PORT"] = String(port)
    env["LAB_DATA_DIR"] = supportDir.appendingPathComponent("data").path
    env["LAB_ENV_FILE"] = supportDir.appendingPathComponent(".env").path
    env["NODE_USE_ENV_PROXY"] = "1"
    // Apps opened from Finder don't inherit the shell's proxy variables, so take the system proxy.
    if env["HTTPS_PROXY"] == nil && env["https_proxy"] == nil, let proxy = systemProxy() {
      env["HTTPS_PROXY"] = proxy
      env["HTTP_PROXY"] = env["HTTP_PROXY"] ?? proxy
    }
    let local = "localhost,127.0.0.1,::1"
    env["NO_PROXY"] = [local, env["NO_PROXY"]].compactMap { $0 }.joined(separator: ",")
    return env
  }

  func systemProxy() -> String? {
    guard let s = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any] else { return nil }
    if (s["HTTPSEnable"] as? Int) == 1, let host = s["HTTPSProxy"] as? String, let port = s["HTTPSPort"] as? Int { return "http://\(host):\(port)" }
    if (s["HTTPEnable"] as? Int) == 1, let host = s["HTTPProxy"] as? String, let port = s["HTTPPort"] as? Int { return "http://\(host):\(port)" }
    return nil
  }

  func freePort(from start: Int) -> Int {
    for candidate in start..<(start + 50) where canBind(candidate) { return candidate }
    return start
  }
  func canBind(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 } }
  }

  func waitUntilReady(deadline: Date) {
    let url = URL(string: "http://127.0.0.1:\(port)/")!
    var req = URLRequest(url: url); req.timeoutInterval = 1
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in ok = (resp as? HTTPURLResponse)?.statusCode == 200; sem.signal() }.resume()
    sem.wait()
    if ok { DispatchQueue.main.async { self.web.load(URLRequest(url: url)) }; return }
    guard server?.isRunning == true else { return }
    if Date() > deadline { DispatchQueue.main.async { self.showMessage("本地服务启动超时", detail: self.logTail()) }; return }
    usleep(250_000)
    waitUntilReady(deadline: deadline)
  }

  func logTail() -> String {
    guard let text = try? String(contentsOf: logFile, encoding: .utf8) else { return "" }
    return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(30).joined(separator: "\n")
  }

  func showMessage(_ title: String, detail: String) {
    let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
    web.loadHTMLString("""
      <html><body style="font:15px -apple-system,'PingFang SC',sans-serif;background:#f3f5f7;color:#1c2230;display:grid;place-items:center;height:100vh;margin:0">
      <div style="max-width:720px;padding:24px"><h2 style="font-weight:600">\(esc(title))</h2>
      \(detail.isEmpty ? "" : "<pre style='white-space:pre-wrap;background:#fff;border-radius:8px;padding:12px;font-size:12px;max-height:50vh;overflow:auto'>\(esc(detail))</pre><p style='color:#667'>完整日志：\(esc(logFile.path))</p>")
      </div></body></html>
      """, baseURL: nil)
  }

  /* ---------- web view ---------- */
  func isLocal(_ url: URL?) -> Bool { guard let h = url?.host else { return url?.scheme == "about" || url?.scheme == "data" || url?.scheme == "blob" }; return h == "127.0.0.1" || h == "localhost" }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if let url = action.request.url, !isLocal(url), url.scheme == "http" || url.scheme == "https" {
      NSWorkspace.shared.open(url); return decisionHandler(.cancel)
    }
    // A clicked link to a stored file (image, model) opens in the browser instead of replacing the lab page.
    if let url = action.request.url, isLocal(url), url.path.hasPrefix("/files/"), !(url.query ?? "").contains("download="), !action.shouldPerformDownload, action.navigationType == .linkActivated, action.targetFrame?.isMainFrame != false {
      NSWorkspace.shared.open(url); return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }
  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    decisionHandler(disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
  }
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.directoryURL = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first
    panel.beginSheetModal(for: window) { r in
      guard r == .OK, let url = panel.url else { return completionHandler(nil) }
      try? fm.removeItem(at: url)
      completionHandler(url)
    }
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    let a = NSAlert(); a.messageText = "下载失败"; a.informativeText = error.localizedDescription; a.beginSheetModal(for: window)
  }

  // target=_blank links: local ones stay in the window, external ones go to the default browser.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { if isLocal(url) && (!url.path.hasPrefix("/files/") || (url.query ?? "").contains("download=")) { webView.load(action.request) } else { NSWorkspace.shared.open(url) } }
    return nil
  }
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
  }
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "好")
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "确定"); a.addButton(withTitle: "取消")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
  }
  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert(); a.messageText = prompt; a.addButton(withTitle: "确定"); a.addButton(withTitle: "取消")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

  /* ---------- menu ---------- */
  @objc func reload() { web.reload() }
  @objc func goBack() { if web.canGoBack { web.goBack() } else { web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)) } }
  @objc func openInBrowser() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)/")!) }
  @objc func openData() { NSWorkspace.shared.open(supportDir) }
  @objc func openLog() { NSWorkspace.shared.activateFileViewerSelecting([logFile]) }
  @objc func zoomIn() { web.pageZoom = min(2, web.pageZoom + 0.1) }
  @objc func zoomOut() { web.pageZoom = max(0.5, web.pageZoom - 0.1) }
  @objc func zoomReset() { web.pageZoom = 1 }

  func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) { let m = NSMenu(title: title); items.forEach(m.addItem); let i = NSMenuItem(); i.submenu = m; main.addItem(i) }
    func item(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i }
    add(appName, [item("关于\(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), .separator(),
                  item("隐藏\(appName)", #selector(NSApplication.hide(_:)), "h"), item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]), .separator(),
                  item("退出\(appName)", #selector(NSApplication.terminate(_:)), "q")])
    add("文件", [item("打开数据文件夹", #selector(openData)), item("在浏览器中打开", #selector(openInBrowser)), item("查看服务日志", #selector(openLog)), .separator(),
                item("关闭窗口", #selector(NSWindow.performClose(_:)), "w")])
    add("编辑", [item("撤销", Selector(("undo:")), "z"), item("重做", Selector(("redo:")), "z", [.command, .shift]), .separator(),
                item("剪切", #selector(NSText.cut(_:)), "x"), item("拷贝", #selector(NSText.copy(_:)), "c"), item("粘贴", #selector(NSText.paste(_:)), "v"),
                item("全选", #selector(NSText.selectAll(_:)), "a")])
    add("显示", [item("返回主界面", #selector(goBack), "["), item("重新载入", #selector(reload), "r"), .separator(), item("放大", #selector(zoomIn), "="), item("缩小", #selector(zoomOut), "-"), item("实际大小", #selector(zoomReset), "0"), .separator(),
                item("进入全屏", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
    let win = NSMenu(title: "窗口"); win.addItem(item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m")); let wi = NSMenuItem(); wi.submenu = win; main.addItem(wi)
    NSApp.windowsMenu = win
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
