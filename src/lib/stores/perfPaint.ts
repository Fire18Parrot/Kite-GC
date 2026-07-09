// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

// Dev-only WebView paint diagnostic: a live toggle to strip all `backdrop-filter` blur
// (glassmorphism) app-wide, to localise the Linux/WebKitGTK 2D idle-paint cost empirically.
// WebKitGTK can full-page-repaint every frame merely because a backdrop-filter is present on the
// page (independent of the filtered area), so removing it is the decisive test. Applied globally
// via a root data-attribute in +page.svelte; surfaced only from the Debug Panel (dev / --debug).
// Ships in release but defaults off → zero visual/perf change. Persisted so a test survives reload.

import { writable, type Writable } from 'svelte/store';

function persisted(key: string): Writable<boolean> {
  const initial = typeof localStorage !== 'undefined' && localStorage.getItem(key) === 'on';
  const store = writable<boolean>(initial);
  store.subscribe((v) => {
    try {
      localStorage.setItem(key, v ? 'on' : 'off');
    } catch {
      /* localStorage unavailable — ignore */
    }
  });
  return store;
}

/** Dev: strip every `backdrop-filter: blur()` (glassmorphism) across the app. */
export const disableBlur = persisted('kite_perf_noblur');
