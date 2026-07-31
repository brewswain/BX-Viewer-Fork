#!/bin/bash

# Function to check if running in a terminal
is_terminal() {
    [ -t 1 ] && return 0 || return 1
}

# If not running in terminal, re-launch in one
if ! is_terminal; then
    OS="$(uname -s)"

    if [[ "$OS" == "Darwin" ]]; then
        # macOS: Open in Terminal.app
        osascript <<EOF
tell application "Terminal"
    activate
    do script "cd '$(pwd)' && '$(realpath "$0")' ; exit"
end tell
EOF
        exit 0

    elif [[ "$OS" == "Linux" ]]; then
        # Linux: Try various terminal emulators
        SCRIPT_PATH="$(realpath "$0")"

        # Try terminal emulators in order of preference
        for term in ghostty gnome-terminal xterm konsole terminator alacritty kitty urxvt rxvt st; do
            if command -v "$term" &>/dev/null; then
                case "$term" in
                    gnome-terminal)
                        gnome-terminal -- bash -c "cd '$(pwd)' && '$SCRIPT_PATH' ; exec bash"
                        ;;
                    xterm|konsole|terminator|urxvt|rxvt|st)
                        $term -e bash -c "cd '$(pwd)' && '$SCRIPT_PATH' ; exec bash"
                        ;;
                    alacritty|kitty)
                        $term -e bash -c "cd '$(pwd)' && '$SCRIPT_PATH' ; exec bash"
                        ;;
                esac
                exit 0
            fi
        done

        # If no terminal found, show error in dialog
        if command -v zenity &>/dev/null; then
            zenity --error --text="No terminal emulator found. Please run this script from the terminal manually."
        elif command -v kdialog &>/dev/null; then
            kdialog --error "No terminal emulator found. Please run this script from the terminal manually."
        else
            echo "No terminal emulator found. Please run this script from the terminal manually."
            read -p "Press Enter to exit..."
        fi
        exit 1
    fi
fi

# ===== Original script starts here =====
echo "===== Starting Server Setup ====="

cd "$(dirname "$0")"

# --dev / -Dev runs the Next.js dev server instead of a production build.
DEV=0
for arg in "$@"; do
    case "$arg" in
        --dev|-Dev|-dev|-d) DEV=1 ;;
    esac
done

# Bun's installer drops it in ~/.bun/bin, which is only on PATH in new shells.
if ! command -v bun &>/dev/null && [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun &>/dev/null; then
    echo "Bun is not installed. It is the JavaScript runtime this app runs on."
    echo "It can be installed with:  curl -fsSL https://bun.sh/install | bash"
    read -p "Install Bun now? (y/n): " choice
    if [[ "$choice" == "y" ]]; then
        if command -v brew &>/dev/null && [[ "$(uname -s)" == "Darwin" ]]; then
            brew install oven-sh/bun/bun
        else
            curl -fsSL https://bun.sh/install | bash
        fi
        export PATH="$HOME/.bun/bin:$PATH"
    else
        echo "Install from: https://bun.sh/"; exit 1
    fi
    if ! command -v bun &>/dev/null; then
        echo "Bun still not found. Please restart this script."; exit 1
    fi
fi

if [ ! -d "node_modules" ]; then
    # --frozen-lockfile writes no lockfile. That matters on exFAT drives, where a
    # plain `bun install` unpacks every package correctly but still exits 1 with
    # "Failed to replace old lockfile with new lockfile on disk" because exFAT has
    # no atomic replace. Fall back to a normal install if the lockfile is stale,
    # and only treat that as fatal when the packages genuinely did not land.
    echo "Installing dependencies..."
    if ! bun install --frozen-lockfile; then
        echo "Lockfile does not match package.json - retrying without --frozen-lockfile..."
        if ! bun install; then
            if [ -d "node_modules/next" ]; then
                echo "bun could not rewrite bun.lock (exFAT has no atomic replace) - packages are fine."
            else
                echo "bun install failed."; exit 1
            fi
        fi
    fi
fi

HTTP_PORT=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).httpPort ?? 8000)' 2>/dev/null)
if [[ -z "$HTTP_PORT" ]]; then HTTP_PORT=8000; fi
# managerPort is vestigial - the manager now lives at /manager on the same port.

LOCAL_IP=""
if command -v ip &>/dev/null; then
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{print $7; exit}')
fi
if [[ -z "$LOCAL_IP" ]] && command -v ipconfig &>/dev/null; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null)
fi
if [[ -z "$LOCAL_IP" ]]; then LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}'); fi
if [[ -z "$LOCAL_IP" ]]; then LOCAL_IP="localhost"; fi

if [[ "$DEV" != "1" ]]; then
    echo "Building the app (this can take a minute)..."
    if ! bun run build; then
        echo "Build failed."
        read -p "Press Enter to close this window..."
        exit 1
    fi
fi

echo ""
echo "  On your local network, open this URL on any device:"
echo "  Home page  ->  http://$LOCAL_IP:$HTTP_PORT"
echo "  This PC    ->  http://localhost:$HTTP_PORT"
echo ""
echo "Press Ctrl+C to stop."
echo ""

if [[ "$DEV" == "1" ]]; then
    bun run dev -p "$HTTP_PORT"
else
    bun run start -p "$HTTP_PORT"
fi

# Keep terminal open if script exits unexpectedly
if [ $? -ne 0 ]; then
    echo ""
    echo "Script encountered an error."
    read -p "Press Enter to close this window..."
fi
