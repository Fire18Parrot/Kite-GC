// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

// Lightweight host-OS detection for platform-specific UI (e.g. macOS traffic-light window controls on
// the LEFT vs the Windows/Linux control cluster on the RIGHT). We read the WebView user-agent rather
// than pulling in @tauri-apps/plugin-os: the string is stable per platform (WKWebView reports
// "Macintosh", WebView2 "Windows", WebKitGTK "Linux") and this only drives cosmetic layout, so a sync
// value with no extra dependency / async round-trip is preferable.

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

/** True when running inside the macOS WebView (WKWebView) — used to mirror native window-control placement. */
export const isMacOS = /Macintosh|Mac OS X/i.test(ua);
