#!/bin/sh
# Install Pace as a macOS LaunchAgent: starts at login, restarts if it dies.
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"
UV="$(command -v uv)"
LABEL=com.haricharank.pace
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$UV</string><string>run</string><string>uvicorn</string>
    <string>app:app</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>8765</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$UV"):/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/pace.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/pace.log</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout is asynchronous; wait for the old instance to unload before loading the new one
i=0; while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Pace is running at http://localhost:8765 (logs: ~/Library/Logs/pace.log)"
