#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ai-sdk-client"
PORT="${PORT:-8787}"
export LC_ALL=C
export LANG=C
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="$APP_NAME-linux-x64"
PACKAGE_ROOT="$SCRIPT_DIR/package"
DIST_DIR="$PACKAGE_ROOT/$PACKAGE_NAME"
ARCHIVE="$SCRIPT_DIR/$PACKAGE_NAME.tar.gz"

cd "$SCRIPT_DIR"

echo "building $APP_NAME..."
npm run build

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp -R dist "$DIST_DIR/dist"

for file in package.json package-lock.json .npmrc config.yaml ".env" ".env.example"; do
  [ -f "$file" ] && cp "$file" "$DIST_DIR/"
done

cat > "$DIST_DIR/start.sh" <<'EOF'
#!/bin/sh
set -eu

APP_NAME="ai-sdk-client"
PORT="${PORT:-8787}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/$APP_NAME.pid"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/$APP_NAME.log}"

cd "$SCRIPT_DIR"
mkdir -p "$LOG_DIR"

# 确保 codex 子进程有可用的 shell。部分服务器 $SHELL 指向不存在的解释器（如未安装的
# zsh），会导致 codex 的命令执行（imagegen 等脚本类技能）起不来。
if [ -z "${SHELL:-}" ] || [ ! -x "${SHELL:-}" ]; then
  if [ -x /bin/bash ]; then SHELL=/bin/bash; else SHELL=/bin/sh; fi
  export SHELL
fi
# 兜底 PATH，避免 codex 找不到常用可执行文件
case ":$PATH:" in *:/usr/bin:*) ;; *) PATH="/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH;; esac

if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "$APP_NAME is already running, pid: $PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -ti ":$PORT" || true)"
  if [ -n "$PORT_PID" ]; then
    echo "port $PORT is already in use by pid: $PORT_PID"
    exit 1
  fi
fi

nohup node dist/server.js > "$LOG_FILE" 2>&1 &
PID="$!"
echo "$PID" > "$PID_FILE"

sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "$APP_NAME started, pid: $PID, port: $PORT, log: $LOG_FILE"
else
  rm -f "$PID_FILE"
  echo "$APP_NAME failed to start, see log: $LOG_FILE" >&2
  exit 1
fi
EOF

cat > "$DIST_DIR/stop.sh" <<'EOF'
#!/bin/sh
set -eu

APP_NAME="ai-sdk-client"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/$APP_NAME.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "$APP_NAME is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "$APP_NAME stopped, pid: $PID"
else
  echo "$APP_NAME pid file exists, but process is not running"
fi

rm -f "$PID_FILE"
EOF

chmod +x "$DIST_DIR/start.sh" "$DIST_DIR/stop.sh"

tar -czf "$ARCHIVE" -C "$PACKAGE_ROOT" "$PACKAGE_NAME"

echo "package created: $ARCHIVE"
