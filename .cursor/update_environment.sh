#!/usr/bin/env bash
# Idempotent Cursor Cloud install/update script.
# Keep this resilient: warnings should not fail environment startup.

set -u -o pipefail

echo "[cursor-env] Starting update script..."
echo "[cursor-env] Working directory: $(pwd)"

# 1) Ruby/Bundler setup for Jekyll repos.
if [[ -f "Gemfile" ]]; then
  if command -v bundle >/dev/null 2>&1; then
    export BUNDLE_SILENCE_ROOT_WARNING=1
    bundle config set --local path "vendor/bundle" >/dev/null 2>&1 || true
    if ! bundle install --jobs 4 --retry 3; then
      echo "[cursor-env][warn] bundle install failed; continuing."
    fi
  else
    echo "[cursor-env][warn] bundler is not installed; skipping Ruby dependency install."
  fi
else
  echo "[cursor-env] No Gemfile found; skipping bundle install."
fi

# 2) Python dependencies used by desktop scripts in this repo.
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -m pip install --user --disable-pip-version-check openpyxl yfinance; then
    echo "[cursor-env][warn] Python dependency install failed; continuing."
  fi
else
  echo "[cursor-env][warn] python3 is not available; skipping Python dependency install."
fi

# 3) tkinter support for desktop GUI scripts (best-effort).
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import tkinter" >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
      echo "[cursor-env] tkinter missing; attempting apt install (python3-tk)."
      if ! apt-get update -y || ! apt-get install -y python3-tk; then
        echo "[cursor-env][warn] Failed to install python3-tk; continuing."
      fi
    else
      echo "[cursor-env][warn] tkinter missing and apt/root unavailable; skipping."
    fi
  fi
fi

echo "[cursor-env] Update script completed."
exit 0
