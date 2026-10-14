#!/bin/zsh
# Compila o app de barra de menus. Saída: desktop/build/Rodrigo AI.app (assinatura ad hoc, uso local).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd -P)"
NODE="$(command -v node)"
APP="build/Rodrigo AI.app"
rm -rf build && mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/RodrigoAI" main.swift
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Rodrigo AI</string>
<key>CFBundleDisplayName</key><string>Rodrigo AI</string>
<key>CFBundleIdentifier</key><string>local.rodrigo-ai.desktop</string>
<key>CFBundleExecutable</key><string>RodrigoAI</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSMicrophoneUsageDescription</key><string>O Rodrigo AI usa o microfone para ouvir você falar.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>RodrigoRepoRoot</key><string>$ROOT</string>
<key>RodrigoNodePath</key><string>$NODE</string>
</dict></plist>
PL
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "ok: $PWD/$APP"
