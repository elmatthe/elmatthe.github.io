#!/bin/bash

cd "$(dirname "$0")"

echo "========================================"
echo "  Stock Comparison & Analytics Tool v0.2.5"
echo "========================================"
echo
echo "  This window sets up and launches the program."
echo "  Setup keeps dependencies inside this project folder."
echo

PYTHON_VERSION="3.11"
REQUIREMENTS="scripts/requirements.txt"
MAIN_SCRIPT="scripts/main.py"
VENV_PYTHON=".venv/bin/python"

echo "Checking for Python..."
if ! command -v python3 &> /dev/null; then
    echo
    echo "  Python 3 is required but was not found."
    echo "  Install Python from https://www.python.org/downloads/macos/"
    read -p "Press Enter to exit..."
    exit 1
fi

mkdir -p .run-temp
export TEMP="$(pwd)/.run-temp"
export TMP="$TEMP"

if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    if [ $? -ne 0 ]; then
        echo "Failed to create virtual environment."
        read -p "Press Enter to exit..."
        exit 1
    fi
fi

if [ ! -x "$VENV_PYTHON" ]; then
    echo "ERROR: Virtual environment Python was not found."
    read -p "Press Enter to exit..."
    exit 1
fi

if [ -f "$REQUIREMENTS" ]; then
    echo "Installing dependencies into the project environment..."
    "$VENV_PYTHON" -m pip install --disable-pip-version-check --no-cache-dir -r "$REQUIREMENTS"
    if [ $? -ne 0 ]; then
        echo "Dependency installation failed."
        read -p "Press Enter to exit..."
        exit 1
    fi
else
    echo "ERROR: Requirements file not found: $REQUIREMENTS"
    read -p "Press Enter to exit..."
    exit 1
fi

echo
echo "Launching application..."
echo

if [ "$STOCK_TOOL_SETUP_ONLY" = "1" ]; then
    echo "Setup-only mode requested. Skipping GUI launch."
    exit 0
fi

if [ -f "$MAIN_SCRIPT" ]; then
    "$VENV_PYTHON" "$MAIN_SCRIPT"
else
    echo "ERROR: Main script not found: $MAIN_SCRIPT"
fi

echo
echo "Program finished."
read -p "Press Enter to close..."
