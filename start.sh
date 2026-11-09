#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

find_python() {
  for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

install_python() {
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      echo "Python 3.9+ is missing and sudo is unavailable." >&2
      echo "Install Python 3.9 or newer manually, then run ./start.sh again." >&2
      exit 1
    fi
  fi

  echo "Python 3.9+ was not found. Installing it for the current system..."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update
    $SUDO apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y python3
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -S --needed --noconfirm python
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper --non-interactive install python3
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add python3
  elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install python
  else
    echo "No supported package manager was found." >&2
    echo "Install Python 3.9 or newer manually, then run ./start.sh again." >&2
    exit 1
  fi
}

PYTHON_CMD="$(find_python || true)"
if [ -z "$PYTHON_CMD" ]; then
  install_python
  PYTHON_CMD="$(find_python || true)"
fi

if [ -z "$PYTHON_CMD" ]; then
  echo "Python installation completed, but Python 3.9+ is still not available." >&2
  echo "You may need to reopen the terminal or install a newer Python manually." >&2
  exit 1
fi

echo "Python: $("$PYTHON_CMD" --version 2>&1)"
echo "Starting http://127.0.0.1:8765/"
exec "$PYTHON_CMD" server.py
