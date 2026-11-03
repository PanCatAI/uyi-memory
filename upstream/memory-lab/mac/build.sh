#!/bin/zsh
# Builds dist/记忆实验台.app: native window + bundled Node + lab code and dependencies.
# Usage: mac/build.sh [--install]   (--install also copies the app to ~/Applications)
set -euo pipefail
cd "$(dirname "$0")/.."
LAB="$PWD"
OUT="$LAB/dist/记忆实验台.app"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Build and sign outside the (possibly iCloud-synced) source folder: synced folders add Finder metadata that codesign rejects.
APP="$WORK/记忆实验台.app"

node_version="$("$NODE_BIN" -p 'process.versions.node')"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=21)?0:1)' \
  || { echo "需要 Node 22.21 以上，当前 $NODE_BIN 是 $node_version"; exit 1; }
[ -d node_modules ] || npm ci --omit=dev

echo "→ 编译窗口程序"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node" "$APP/Contents/Resources/app"
swiftc -O -target arm64-apple-macos13 -o "$WORK/Lab-arm64" mac/LabApp.swift -framework Cocoa -framework WebKit
cp "$WORK/Lab-arm64" "$APP/Contents/MacOS/Lab"

echo "→ 图标"
swift mac/make-icon.swift "$WORK/icon.png"
mkdir "$WORK/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

echo "→ 复制 Node $node_version 和实验台代码"
cp "$NODE_BIN" "$APP/Contents/Resources/node/node"
chmod u+w "$APP/Contents/Resources/node/node" # Homebrew may install Node read-only; xattr needs write permission.
# A shared-library Node can run in Homebrew but fail after being copied into the app.
# Check the relocated runtime before replacing a working build or installation.
"$APP/Contents/Resources/node/node" -e 'process.exit(0)' 2>"$WORK/node-check.log" \
  || { echo "Node 复制后无法独立启动。请用 NODE_BIN 指向 Node 官方 macOS arm64 独立可执行文件。"; cat "$WORK/node-check.log"; exit 1; }
rsync -a --delete server.mjs package.json lib public contracts prompts scenes characters scenarios node_modules "$APP/Contents/Resources/app/"

version="$("$NODE_BIN" -p 'require("./package.json").version')"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>记忆实验台</string>
  <key>CFBundleDisplayName</key><string>记忆实验台</string>
  <key>CFBundleIdentifier</key><string>ai.pancat.uyi-memory-lab</string>
  <key>CFBundleExecutable</key><string>Lab</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>LabSourceDir</key><string>$LAB</string>
</dict></plist>
PLIST

echo "→ 本机签名"
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
rm -rf "$OUT"; mkdir -p "$(dirname "$OUT")"; ditto "$APP" "$OUT"
echo "完成：$OUT（$(du -sh "$APP" | cut -f1)）"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/记忆实验台.app"
  ditto "$APP" "$HOME/Applications/记忆实验台.app"
  codesign --verify "$HOME/Applications/记忆实验台.app" && echo "已安装到 ~/Applications/记忆实验台.app"
fi
