#!/usr/bin/env swift

import AppKit
import ApplicationServices
import Foundation

struct TargetSnapshot: Encodable {
    struct SelectedRangeSnapshot: Encodable {
        let location: Int
        let length: Int
    }

    let bundleId: String
    let appName: String
    let role: String?
    let subrole: String?
    let title: String?
    let focused: Bool
    let enabled: Bool
    let editable: Bool
    let secure: Bool
    let supportsValue: Bool
    let directInsertSupported: Bool
    let appendSupported: Bool
    let value: String?
    let selectedText: String?
    let selectedRange: SelectedRangeSnapshot?
}

struct TreeNodeSnapshot: Encodable {
    let path: String
    let role: String?
    let title: String?
    let value: String?
    let enabled: Bool?
    let focused: Bool?
    let secure: Bool
}

struct SuccessOutput: Encodable {
    let ok = true
    let snapshot: TargetSnapshot?
    let strategy: String?
    let tree: [TreeNodeSnapshot]?
    let text: String?
    let trusted: Bool?
}

enum HelperError: Error, CustomStringConvertible {
    case invalidArgs
    case accessibilityDisabled
    case noFocusedApplication
    case noFocusedElement
    case notEditable
    case notEnabled
    case valueUnavailable
    case selectionUnavailable
    case selectionRequired
    case secureFieldDenied
    case elementNotFound(String)
    case unsupportedOperation(String)
    case axFailure(String, AXError)

    var description: String {
        switch self {
        case .invalidArgs:
            return "invalid arguments"
        case .accessibilityDisabled:
            return "assistive access disabled"
        case .noFocusedApplication:
            return "no focused application"
        case .noFocusedElement:
            return "no focused element"
        case .notEditable:
            return "focused element is not editable"
        case .notEnabled:
            return "focused element is disabled"
        case .valueUnavailable:
            return "focused element does not expose AXValue"
        case .selectionUnavailable:
            return "focused element does not expose AXSelectedTextRange"
        case .selectionRequired:
            return "focused element has no selected text"
        case .secureFieldDenied:
            return "secure field denied"
        case let .elementNotFound(hint):
            return "element not found: \(hint)"
        case let .unsupportedOperation(mode):
            return "unsupported operation: \(mode)"
        case let .axFailure(context, error):
            return "\(context) failed with AXError \(error.rawValue)"
        }
    }
}

func fail(_ error: Error) -> Never {
    fputs("\(error)\n", stderr)
    exit(1)
}

func copyAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute, &value)
    switch err {
    case .success:
        return value
    case .noValue, .attributeUnsupported:
        return nil
    case .apiDisabled:
        throw HelperError.accessibilityDisabled
    default:
        throw HelperError.axFailure("read \(attribute)", err)
    }
}

func isAttributeSettable(_ element: AXUIElement, _ attribute: CFString) throws -> Bool {
    var settable = DarwinBoolean(false)
    let err = AXUIElementIsAttributeSettable(element, attribute, &settable)
    switch err {
    case .success:
        return settable.boolValue
    case .attributeUnsupported:
        return false
    case .apiDisabled:
        throw HelperError.accessibilityDisabled
    default:
        throw HelperError.axFailure("check settable \(attribute)", err)
    }
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> String? {
    guard let raw = try copyAttribute(element, attribute) else {
        return nil
    }
    if let value = raw as? String {
        return value
    }
    if let value = raw as? NSString {
        return value as String
    }
    if let value = raw as? NSAttributedString {
        return value.string
    }
    return nil
}

func boolAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> Bool? {
    guard let raw = try copyAttribute(element, attribute) else {
        return nil
    }
    if let value = raw as? NSNumber {
        return value.boolValue
    }
    if let value = raw as? Bool {
        return value
    }
    return nil
}

func rangeAttribute(_ element: AXUIElement, _ attribute: CFString) throws -> CFRange? {
    guard let raw = try copyAttribute(element, attribute) else {
        return nil
    }
    guard CFGetTypeID(raw) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = unsafeBitCast(raw, to: AXValue.self)
    guard AXValueGetType(axValue) == .cfRange else {
        return nil
    }
    var range = CFRange()
    guard AXValueGetValue(axValue, .cfRange, &range) else {
        return nil
    }
    return range
}

func setStringAttribute(_ element: AXUIElement, _ attribute: CFString, _ value: String) throws {
    let err = AXUIElementSetAttributeValue(element, attribute, value as CFTypeRef)
    switch err {
    case .success:
        return
    case .apiDisabled:
        throw HelperError.accessibilityDisabled
    default:
        throw HelperError.axFailure("set \(attribute)", err)
    }
}

func setRangeAttribute(_ element: AXUIElement, _ attribute: CFString, location: Int, length: Int) throws {
    var range = CFRange(location: location, length: length)
    guard let axValue = AXValueCreate(.cfRange, &range) else {
        throw HelperError.selectionUnavailable
    }
    let err = AXUIElementSetAttributeValue(element, attribute, axValue)
    switch err {
    case .success:
        return
    case .apiDisabled:
        throw HelperError.accessibilityDisabled
    default:
        throw HelperError.axFailure("set \(attribute)", err)
    }
}

func performAction(_ element: AXUIElement, _ action: CFString) throws {
    let err = AXUIElementPerformAction(element, action)
    switch err {
    case .success:
        return
    case .apiDisabled:
        throw HelperError.accessibilityDisabled
    default:
        throw HelperError.axFailure("action \(action)", err)
    }
}

func isSecureElement(_ element: AXUIElement) throws -> Bool {
    let role = try stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
    let subrole = try stringAttribute(element, kAXSubroleAttribute as CFString) ?? ""
    return role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

func denyIfSecure(_ element: AXUIElement) throws {
    if try isSecureElement(element) {
        throw HelperError.secureFieldDenied
    }
}

func focusedContext() throws -> (app: AXUIElement, appName: String, bundleId: String, element: AXUIElement) {
    let system = AXUIElementCreateSystemWide()
    guard let appRaw = try copyAttribute(system, kAXFocusedApplicationAttribute as CFString) else {
        throw HelperError.noFocusedApplication
    }
    let app = unsafeBitCast(appRaw, to: AXUIElement.self)
    var pid: pid_t = 0
    let pidErr = AXUIElementGetPid(app, &pid)
    guard pidErr == .success else {
        throw HelperError.axFailure("read focused pid", pidErr)
    }
    let running = NSRunningApplication(processIdentifier: pid)
    let appName = running?.localizedName ?? "Unknown App"
    let bundleId = running?.bundleIdentifier ?? ""
    guard let elementRaw = try copyAttribute(app, kAXFocusedUIElementAttribute as CFString) else {
        throw HelperError.noFocusedElement
    }
    let element = unsafeBitCast(elementRaw, to: AXUIElement.self)
    return (app, appName, bundleId, element)
}

func snapshot() throws -> TargetSnapshot {
    let ctx = try focusedContext()
    try denyIfSecure(ctx.element)
    let role = try stringAttribute(ctx.element, kAXRoleAttribute as CFString)
    let subrole = try stringAttribute(ctx.element, kAXSubroleAttribute as CFString)
    let title = try stringAttribute(ctx.element, kAXTitleAttribute as CFString)
    let focused = try boolAttribute(ctx.element, kAXFocusedAttribute as CFString) ?? true
    let enabled = try boolAttribute(ctx.element, kAXEnabledAttribute as CFString) ?? true
    let editableAttr = try boolAttribute(ctx.element, "AXEditable" as CFString) ?? false
    let value = try stringAttribute(ctx.element, kAXValueAttribute as CFString)
    let selectedText = try stringAttribute(ctx.element, kAXSelectedTextAttribute as CFString)
    let selectedRange = try rangeAttribute(ctx.element, kAXSelectedTextRangeAttribute as CFString)
    let settable = try isAttributeSettable(ctx.element, kAXValueAttribute as CFString)
    let supportsValue = (value != nil) || settable
    let directInsertSupported = supportsValue && selectedRange != nil
    let appendSupported = supportsValue && value != nil
    let secureRoles = Set(["AXSecureTextField"])
    let textRoles = Set([
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXWebArea",
        "AXGroup", "AXScrollArea", "AXUnknown"
    ])
    let secure = secureRoles.contains(role ?? "") || secureRoles.contains(subrole ?? "")
    let editable = !secure && (
        editableAttr
            || (supportsValue && textRoles.contains(role ?? ""))
            || (selectedRange != nil && textRoles.contains(role ?? ""))
    )
    let rangeSnapshot = selectedRange.map { TargetSnapshot.SelectedRangeSnapshot(location: $0.location, length: $0.length) }

    return TargetSnapshot(
        bundleId: ctx.bundleId,
        appName: ctx.appName,
        role: role,
        subrole: subrole,
        title: title,
        focused: focused,
        enabled: enabled,
        editable: editable,
        secure: secure,
        supportsValue: supportsValue,
        directInsertSupported: directInsertSupported,
        appendSupported: appendSupported,
        value: value,
        selectedText: selectedText,
        selectedRange: rangeSnapshot
    )
}

func setSelection(_ element: AXUIElement, location: Int) throws {
    try setRangeAttribute(
        element,
        kAXSelectedTextRangeAttribute as CFString,
        location: location,
        length: 0
    )
}

func replaceValue(_ snapshot: TargetSnapshot, text: String, mode: String) throws {
    let ctx = try focusedContext()
    try denyIfSecure(ctx.element)
    guard snapshot.enabled else { throw HelperError.notEnabled }
    guard snapshot.editable else { throw HelperError.notEditable }
    guard let currentValue = snapshot.value else { throw HelperError.valueUnavailable }

    switch mode {
    case "append":
        let next = currentValue + text
        try setStringAttribute(ctx.element, kAXValueAttribute as CFString, next)
        try setSelection(ctx.element, location: (next as NSString).length)
    case "insert", "replaceSelection":
        guard let selectedRange = snapshot.selectedRange else {
            throw HelperError.selectionUnavailable
        }
        if mode == "replaceSelection" && (snapshot.selectedText ?? "").isEmpty && selectedRange.length == 0 {
            throw HelperError.selectionRequired
        }
        let current = currentValue as NSString
        let location = max(0, min(selectedRange.location, current.length))
        let length = max(0, min(selectedRange.length, current.length - location))
        let prefix = current.substring(to: location)
        let suffix = current.substring(from: location + length)
        let next = prefix + text + suffix
        try setStringAttribute(ctx.element, kAXValueAttribute as CFString, next)
        try setSelection(ctx.element, location: location + (text as NSString).length)
    default:
        throw HelperError.unsupportedOperation(mode)
    }
}

func children(of element: AXUIElement) throws -> [AXUIElement] {
    guard let raw = try copyAttribute(element, kAXChildrenAttribute as CFString) else {
        return []
    }
    guard let arr = raw as? [AXUIElement] else {
        return []
    }
    return arr
}

func collectTree(
    _ element: AXUIElement,
    path: String,
    depth: Int,
    maxDepth: Int,
    maxNodes: Int,
    into nodes: inout [TreeNodeSnapshot]
) throws {
    if nodes.count >= maxNodes || depth > maxDepth {
        return
    }
    let role = try stringAttribute(element, kAXRoleAttribute as CFString)
    let title = try stringAttribute(element, kAXTitleAttribute as CFString)
    let secure = try isSecureElement(element)
    let value: String?
    if secure {
        value = nil
    } else {
        let raw = try stringAttribute(element, kAXValueAttribute as CFString)
        if let raw, raw.count > 80 {
            value = String(raw.prefix(80)) + "…"
        } else {
            value = raw
        }
    }
    let enabled = try boolAttribute(element, kAXEnabledAttribute as CFString)
    let focused = try boolAttribute(element, kAXFocusedAttribute as CFString)
    nodes.append(
        TreeNodeSnapshot(
            path: path,
            role: role,
            title: title.map { $0.count > 60 ? String($0.prefix(60)) + "…" : $0 },
            value: value,
            enabled: enabled,
            focused: focused,
            secure: secure
        )
    )
    if depth >= maxDepth {
        return
    }
    let kids = try children(of: element)
    for (i, kid) in kids.prefix(40).enumerated() {
        if nodes.count >= maxNodes {
            return
        }
        try collectTree(kid, path: "\(path)/\(i)", depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes, into: &nodes)
    }
}

func frontmostTree(maxDepth: Int = 4, maxNodes: Int = 120) throws -> [TreeNodeSnapshot] {
    let ctx = try focusedContext()
    var nodes: [TreeNodeSnapshot] = []
    try collectTree(ctx.app, path: "0", depth: 0, maxDepth: maxDepth, maxNodes: maxNodes, into: &nodes)
    return nodes
}

func elementAtPath(_ root: AXUIElement, path: String) throws -> AXUIElement {
    let parts = path.split(separator: "/").compactMap { Int($0) }
    var current = root
    for idx in parts.dropFirst() {
        let kids = try children(of: current)
        guard idx >= 0, idx < kids.count else {
            throw HelperError.elementNotFound(path)
        }
        current = kids[idx]
    }
    return current
}

func findByTitleRole(_ root: AXUIElement, title: String?, role: String?, maxVisit: Int = 400) throws -> AXUIElement? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    let wantTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let wantRole = role?.trimmingCharacters(in: .whitespacesAndNewlines)
    while !queue.isEmpty, visited < maxVisit {
        let el = queue.removeFirst()
        visited += 1
        let elRole = try stringAttribute(el, kAXRoleAttribute as CFString)
        let elTitle = (try stringAttribute(el, kAXTitleAttribute as CFString) ?? "").lowercased()
        let roleOk = wantRole == nil || wantRole!.isEmpty || elRole == wantRole
        let titleOk = wantTitle == nil || wantTitle!.isEmpty || elTitle.contains(wantTitle!)
        if roleOk && titleOk && (wantTitle != nil || wantRole != nil) {
            return el
        }
        queue.append(contentsOf: try children(of: el))
    }
    return nil
}

func resolveTarget(path: String?, title: String?, role: String?) throws -> AXUIElement {
    let ctx = try focusedContext()
    if let path, !path.isEmpty {
        let el = try elementAtPath(ctx.app, path: path)
        try denyIfSecure(el)
        return el
    }
    if let found = try findByTitleRole(ctx.app, title: title, role: role) {
        try denyIfSecure(found)
        return found
    }
    throw HelperError.elementNotFound("title=\(title ?? "") role=\(role ?? "")")
}

func pressElement(path: String?, title: String?, role: String?) throws {
    let el = try resolveTarget(path: path, title: title, role: role)
    try denyIfSecure(el)
    try performAction(el, kAXPressAction as CFString)
}

func copySelectedText() throws -> String {
    let ctx = try focusedContext()
    try denyIfSecure(ctx.element)
    if let selected = try stringAttribute(ctx.element, kAXSelectedTextAttribute as CFString), !selected.isEmpty {
        return selected
    }
    throw HelperError.selectionRequired
}

func selectMenu(path: String) throws {
    // path: "Edit/Copy" or "Arquivo/Novo"
    let parts = path.split(separator: "/").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    guard parts.count >= 2 else {
        throw HelperError.invalidArgs
    }
    let ctx = try focusedContext()
    guard let menuBarRaw = try copyAttribute(ctx.app, kAXMenuBarAttribute as CFString) else {
        throw HelperError.elementNotFound("menu bar")
    }
    let menuBar = unsafeBitCast(menuBarRaw, to: AXUIElement.self)
    var current = menuBar
    for (i, part) in parts.enumerated() {
        let kids = try children(of: current)
        guard let next = try kids.first(where: { kid in
            let t = (try? stringAttribute(kid, kAXTitleAttribute as CFString)) ?? ""
            return t.caseInsensitiveCompare(part) == .orderedSame
        }) else {
            throw HelperError.elementNotFound(parts.prefix(i + 1).joined(separator: "/"))
        }
        current = next
        if i < parts.count - 1 {
            try? performAction(current, kAXPressAction as CFString)
            // After pressing a menu title, children are the menu items.
            if let menuKids = try? children(of: current), !menuKids.isEmpty {
                // stay on current; next iteration looks in children
            }
        }
    }
    try denyIfSecure(current)
    try performAction(current, kAXPressAction as CFString)
}

func keyCode(for key: String) -> CGKeyCode? {
    let map: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
        "space": 49, "return": 36, "enter": 36, "tab": 48, "delete": 51, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126
    ]
    return map[key.lowercased()]
}

func hotkey(key: String, modifiers: [String]) throws {
    guard let code = keyCode(for: key) else {
        throw HelperError.unsupportedOperation("key:\(key)")
    }
    var flags: CGEventFlags = []
    for m in modifiers {
        switch m.lowercased() {
        case "cmd", "command", "meta":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "alt", "option":
            flags.insert(.maskAlternate)
        case "ctrl", "control":
            flags.insert(.maskControl)
        default:
            throw HelperError.unsupportedOperation("modifier:\(m)")
        }
    }
    guard let src = CGEventSource(stateID: .hidSystemState) else {
        throw HelperError.axFailure("create event source", .failure)
    }
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else {
        throw HelperError.axFailure("create key event", .failure)
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func encode<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        fail(HelperError.axFailure("encode json", .failure))
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail(HelperError.invalidArgs)
}

do {
    switch command {
    case "prompt":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        encode(SuccessOutput(snapshot: nil, strategy: nil, tree: nil, text: nil, trusted: trusted))
    case "trusted":
        encode(SuccessOutput(snapshot: nil, strategy: nil, tree: nil, text: nil, trusted: AXIsProcessTrusted()))
    case "inspect":
        // inspect may target a secure field for detection; snapshot() denies secure — use raw check first
        let ctx = try focusedContext()
        if try isSecureElement(ctx.element) {
            let role = try stringAttribute(ctx.element, kAXRoleAttribute as CFString)
            let subrole = try stringAttribute(ctx.element, kAXSubroleAttribute as CFString)
            let snap = TargetSnapshot(
                bundleId: ctx.bundleId,
                appName: ctx.appName,
                role: role,
                subrole: subrole,
                title: try stringAttribute(ctx.element, kAXTitleAttribute as CFString),
                focused: true,
                enabled: try boolAttribute(ctx.element, kAXEnabledAttribute as CFString) ?? true,
                editable: false,
                secure: true,
                supportsValue: false,
                directInsertSupported: false,
                appendSupported: false,
                value: nil,
                selectedText: nil,
                selectedRange: nil
            )
            encode(SuccessOutput(snapshot: snap, strategy: nil, tree: nil, text: nil, trusted: nil))
        } else {
            encode(SuccessOutput(snapshot: try snapshot(), strategy: nil, tree: nil, text: nil, trusted: nil))
        }
    case "insert":
        guard args.count >= 3 else {
            throw HelperError.invalidArgs
        }
        let mode = args[1]
        let text = args[2]
        let current = try snapshot()
        try replaceValue(current, text: text, mode: mode)
        encode(SuccessOutput(snapshot: nil, strategy: "ax", tree: nil, text: nil, trusted: nil))
    case "tree":
        let tree = try frontmostTree()
        encode(SuccessOutput(snapshot: nil, strategy: nil, tree: tree, text: nil, trusted: nil))
    case "click", "press":
        // click|press [path:<p>] [title:<t>] [role:<r>]
        var pathArg: String?
        var titleArg: String?
        var roleArg: String?
        for a in args.dropFirst() {
            if a.hasPrefix("path:") { pathArg = String(a.dropFirst(5)) }
            else if a.hasPrefix("title:") { titleArg = String(a.dropFirst(6)) }
            else if a.hasPrefix("role:") { roleArg = String(a.dropFirst(5)) }
        }
        try pressElement(path: pathArg, title: titleArg, role: roleArg)
        encode(SuccessOutput(snapshot: nil, strategy: "ax_press", tree: nil, text: nil, trusted: nil))
    case "hotkey":
        // hotkey <key> [mod1,mod2]
        guard args.count >= 2 else { throw HelperError.invalidArgs }
        let key = args[1]
        let mods = args.count >= 3 ? args[2].split(separator: ",").map(String.init) : []
        try hotkey(key: key, modifiers: mods)
        encode(SuccessOutput(snapshot: nil, strategy: "hotkey", tree: nil, text: nil, trusted: nil))
    case "select_menu":
        guard args.count >= 2 else { throw HelperError.invalidArgs }
        try selectMenu(path: args[1])
        encode(SuccessOutput(snapshot: nil, strategy: "select_menu", tree: nil, text: nil, trusted: nil))
    case "copy_selection", "get_selected_text":
        let text = try copySelectedText()
        encode(SuccessOutput(snapshot: nil, strategy: "copy_selection", tree: nil, text: text, trusted: nil))
    default:
        throw HelperError.invalidArgs
    }
} catch {
    fail(error)
}
