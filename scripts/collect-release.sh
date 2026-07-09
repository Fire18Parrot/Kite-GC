#!/bin/bash
# ============================================================
# Kite Ground Control — collect + rename build outputs (Linux + macOS)
# Renames Tauri's outputs to a unified scheme and drops them in <repo>/release/:
#
#     KiteGC_<OS>_<Arch>_<Version>_<Type>.<ext>
#
#   Type = installer   (.deb / .rpm / .dmg)
#        | standalone  (.AppImage / .app-as-zip — self-contained runnable app)
#        | portable     (the bare CLI binary, zipped with an empty `.portable` marker so the
#                        download keeps its data in a data/ folder next to the executable)
#
# One naming source shared by local builds (`just build*`) AND the GitHub release workflow, so the
# filenames are identical everywhere. The release/ folder is git-ignored (fresh each run).
# ============================================================
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(grep '"version"' "$ROOT/package.json" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
TARGET="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
OUT="$ROOT/release"
APP="KiteGC"

case "$(uname -s)" in
    Darwin) OS="macOS" ;;
    Linux)  OS="Linux" ;;
    *)      OS="$(uname -s)" ;;
esac
if [ "$OS" = "macOS" ]; then
    # The macOS build is always universal (arm64 + x86_64 in one bundle).
    ARCH="universal"
else
    case "$(uname -m)" in
        x86_64 | amd64)  ARCH="x64" ;;
        aarch64 | arm64) ARCH="arm64" ;;
        *)               ARCH="$(uname -m)" ;;
    esac
fi

name() { printf '%s_%s_%s_%s_%s.%s' "$APP" "$OS" "$ARCH" "$VERSION" "$1" "$2"; }

rm -rf "$OUT"
mkdir -p "$OUT"
collected=()

# Copy the first file matching <glob> under the unified name <type>.<ext>.
grab_file() { # <glob> <type> <ext>
    for f in $1; do
        [ -e "$f" ] || continue
        dest="$(name "$2" "$3")"
        cp -f "$f" "$OUT/$dest"
        collected+=("$dest")
        return 0
    done
}

# Zip a bare binary + a generated empty `.portable` marker under the unified portable name.
zip_portable() { # <binary-path> <name-in-zip>
    [ -f "$1" ] || return 0
    local tmp dest
    tmp="$(mktemp -d)"
    cp -f "$1" "$tmp/$2"
    chmod +x "$tmp/$2" 2>/dev/null || true
    : > "$tmp/.portable"
    dest="$(name portable zip)"
    (cd "$tmp" && zip -q "$OUT/$dest" "$2" .portable)
    rm -rf "$tmp"
    collected+=("$dest")
}

if [ "$OS" = "macOS" ]; then
    BUNDLE="$TARGET/universal-apple-darwin/release/bundle"
    grab_file "$BUNDLE/dmg/*.dmg" installer dmg
    # .app is a bundle (directory) → zip with ditto so the bundle structure/symlinks stay intact.
    for app in "$BUNDLE"/macos/*.app; do
        [ -e "$app" ] || continue
        dest="$(name standalone zip)"
        (cd "$(dirname "$app")" && ditto -c -k --keepParent "$(basename "$app")" "$OUT/$dest")
        collected+=("$dest")
        break
    done
else
    REL="$TARGET/release"
    BUNDLE="$REL/bundle"
    grab_file "$BUNDLE/deb/*.deb" installer deb
    grab_file "$BUNDLE/rpm/*.rpm" installer rpm
    grab_file "$BUNDLE/appimage/*.AppImage" standalone AppImage
    zip_portable "$REL/kite-gc" kite-gc
fi

echo ""
if [ ${#collected[@]} -eq 0 ]; then
    echo "[collect-release] No build outputs found under $TARGET — did the build succeed?"
else
    echo "[collect-release] Collected into $OUT :"
    for c in "${collected[@]}"; do echo "  - $c"; done
fi
