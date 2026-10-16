#!/usr/bin/env swift
/**
 * Cola texto no campo focado via clipboard + Cmd+V sintético (CGEvent HID).
 *
 * Cópia fiel do mecanismo de `ClipboardPaster.swift` do DitadoLocal:
 * - clipboard é o caminho PRINCIPAL (AXUIElement falha em Electron/WebView)
 * - Cmd+V com flags `.maskCommand` explícitos (nunca herda Option/Shift físicos)
 * - post em `.cghidEventTap` (nível HID; AppleScript `keystroke` é menos confiável)
 * - restaura o clipboard do usuário após 500ms só se o changeCount não mudou
 *
 * Uso: xcrun swift scripts/clipboard_paste.swift paste -- "texto"
 *      printf %s "texto" | xcrun swift scripts/clipboard_paste.swift paste
 */
import Cocoa

enum HelperError: Error, CustomStringConvertible {
    case invalidArgs
    case emptyText
    case eventSourceUnavailable
    case eventCreateFailed

    var description: String {
        switch self {
        case .invalidArgs: return "invalid arguments"
        case .emptyText: return "empty text"
        case .eventSourceUnavailable: return "CGEventSource unavailable"
        case .eventCreateFailed: return "failed to create CGEvent"
        }
    }
}

func fail(_ error: Error) -> Never {
    fputs("\(error)\n", stderr)
    exit(1)
}

func snapshotCurrentItems() -> [NSPasteboardItem] {
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

func postSyntheticCommandV() throws {
    guard let source = CGEventSource(stateID: .combinedSessionState) else {
        throw HelperError.eventSourceUnavailable
    }
    let vKeyCode: CGKeyCode = 9 // kVK_ANSI_V
    guard
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: false)
    else {
        throw HelperError.eventCreateFailed
    }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
}

func paste(_ text: String) throws {
    let pasteboard = NSPasteboard.general
    let previousItems = snapshotCurrentItems()

    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    let ourChangeCount = pasteboard.changeCount

    try postSyntheticCommandV()

    // Bloqueante: o helper é um processo curto; o Node espera o exit.
    Thread.sleep(forTimeInterval: 0.5)
    guard pasteboard.changeCount == ourChangeCount else { return }
    pasteboard.clearContents()
    if !previousItems.isEmpty {
        pasteboard.writeObjects(previousItems)
    }
}

func readText(from args: [String]) throws -> String {
    if let dash = args.firstIndex(of: "--"), dash + 1 < args.count {
        let text = args[(dash + 1)...].joined(separator: " ")
        if text.isEmpty { throw HelperError.emptyText }
        return text
    }
    // stdin (binário UTF-8)
    var data = Data()
    while let chunk = try? FileHandle.standardInput.read(upToCount: 64 * 1024), !chunk.isEmpty {
        data.append(chunk)
    }
    guard let text = String(data: data, encoding: .utf8), !text.isEmpty else {
        throw HelperError.emptyText
    }
    return text
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(HelperError.invalidArgs) }

do {
    switch command {
    case "paste":
        let text = try readText(from: Array(args.dropFirst()))
        try paste(text)
        print("{\"ok\":true,\"strategy\":\"cgevent\"}")
    default:
        throw HelperError.invalidArgs
    }
} catch {
    fail(error)
}
