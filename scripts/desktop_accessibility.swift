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
    let supportsValue: Bool
    let directInsertSupported: Bool
    let appendSupported: Bool
    let value: String?
    let selectedText: String?
    let selectedRange: SelectedRangeSnapshot?
}

struct SuccessOutput: Encodable {
    let ok = true
    let snapshot: TargetSnapshot?
    let strategy: String?
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
    let role = try stringAttribute(ctx.element, kAXRoleAttribute as CFString)
    let subrole = try stringAttribute(ctx.element, kAXSubroleAttribute as CFString)
    let title = try stringAttribute(ctx.element, kAXTitleAttribute as CFString)
    let focused = try boolAttribute(ctx.element, kAXFocusedAttribute as CFString) ?? true
    let enabled = try boolAttribute(ctx.element, kAXEnabledAttribute as CFString) ?? true
    let value = try stringAttribute(ctx.element, kAXValueAttribute as CFString)
    let selectedText = try stringAttribute(ctx.element, kAXSelectedTextAttribute as CFString)
    let selectedRange = try rangeAttribute(ctx.element, kAXSelectedTextRangeAttribute as CFString)
    // Não existe kAXEditableAttribute na API de Acessibilidade: editabilidade = papel de texto + valor gravável.
    let textRoles = Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXWebArea"])
    let settable = try isAttributeSettable(ctx.element, kAXValueAttribute as CFString)
    let supportsValue = (value != nil) || settable
    let directInsertSupported = supportsValue && selectedRange != nil
    let appendSupported = supportsValue && value != nil
    let editable = supportsValue && textRoles.contains(role ?? "")
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
        // Pede o consentimento: abre os Ajustes no painel certo COM este binário já
        // listado (a permissão é atribuída a QUEM chama a API de Acessibilidade, ou seja,
        // a este helper — não ao node). Devolve trusted=false até o usuário ligar a chave.
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        struct PromptOutput: Encodable {
            let ok: Bool
            let trusted: Bool
        }
        encode(PromptOutput(ok: true, trusted: trusted))
    case "inspect":
        encode(SuccessOutput(snapshot: try snapshot(), strategy: nil))
    case "insert":
        guard args.count >= 3 else {
            throw HelperError.invalidArgs
        }
        let mode = args[1]
        let text = args[2]
        let current = try snapshot()
        try replaceValue(current, text: text, mode: mode)
        encode(SuccessOutput(snapshot: nil, strategy: "ax"))
    default:
        throw HelperError.invalidArgs
    }
} catch {
    fail(error)
}
