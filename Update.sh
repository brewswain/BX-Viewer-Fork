#!/bin/bash
cd "$(dirname "$0")"

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

bun scripts/update.ts "$@"
