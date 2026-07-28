// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

// Main-thread side of the off-thread MJPEG reader (see `mjpegWorker.ts` for the why and the
// measurements). One worker reads the multipart stream and draws into every attached canvas; this
// module owns the worker, hands surfaces in via a Svelte action, and republishes its stats.
//
// Everything degrades to the old <img> sink when a WebView lacks a piece — `canvasSinkAvailable` is
// the single switch the surfaces branch on.

import { writable, get } from 'svelte/store';

/** Live figures from the reader, refreshed once a second while a feed runs. `fpsIn` is what arrives
 *  from the server, `fpsOut` what actually reaches a canvas — the gap is the machine falling behind. */
export interface MjpegStats {
  fpsIn: number;
  fpsOut: number;
  kbps: number;
  /** Frames skipped in total and in the last second. */
  dropped: number;
  droppedNow: number;
  corrupt: number;
  /** Longest interval in the last second between two arrivals / two drawn frames. A visible freeze
   *  IS a long `gapDraw`; a matching `gapIn` puts the cause upstream of this machine. */
  gapIn: number;
  gapDraw: number;
  decodeAvgMs: number;
  decodeMaxMs: number;
  width: number;
  height: number;
  /** Milliseconds since the last frame arrived, or -1 before the first one. */
  sinceFrameMs: number;
}

export const mjpegStats = writable<MjpegStats | null>(null);

/** Longest gap between two main-thread animation frames in the last second. The worker draws
 *  independently of this, so a smooth `gapDraw` next to a large `uiJankMs` means the picture is being
 *  produced fine and something else in the app is stalling — a different problem with a different fix. */
export const uiJankMs = writable<number | null>(null);

let jankRaf = 0;

/** Only runs while someone is looking (the Debug Monitor's video tab) — a permanent rAF loop would
 *  keep the page ticking for nothing on a machine that has little to spare. */
export function startJankProbe(): void {
  if (jankRaf || typeof requestAnimationFrame !== 'function') return;
  let prev = performance.now();
  let worst = 0;
  let windowStart = prev;
  const tick = (now: number) => {
    worst = Math.max(worst, now - prev);
    prev = now;
    if (now - windowStart >= 1000) {
      uiJankMs.set(worst);
      worst = 0;
      windowStart = now;
    }
    jankRaf = requestAnimationFrame(tick);
  };
  jankRaf = requestAnimationFrame(tick);
}

export function stopJankProbe(): void {
  if (jankRaf) cancelAnimationFrame(jankRaf);
  jankRaf = 0;
  uiJankMs.set(null);
}

type OutMessage =
  | ({ type: 'stats' } & MjpegStats)
  | { type: 'size'; width: number; height: number }
  | { type: 'error'; message: string; everDrew: boolean };

/** Can this WebView run the off-thread path at all? Checked once: a worker, a canvas it can take
 *  over, a 2D context on it (WebKit shipped OffscreenCanvas for WebGL first), off-thread JPEG
 *  decoding, and a readable response body. */
function detect(): boolean {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return false;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return false;
  if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return false;
  if (typeof Response === 'undefined' || !('body' in Response.prototype)) return false;
  try {
    if (!new OffscreenCanvas(1, 1).getContext('2d')) return false;
  } catch {
    return false;
  }
  return true;
}

/** Whether the surfaces render a worker-drawn `<canvas>` (true) or the plain `<img>` (false). A store
 *  rather than a constant because it can still turn itself off at runtime: if the reader never gets a
 *  single frame — a cross-origin fetch the WebView refuses looks precisely like that — falling back
 *  silently is far better than leaving the user with an endlessly reconnecting stream. */
export const canvasSink = writable(detect());

let worker: Worker | null = null;
let nextId = 1;
let handlers: { onSize?: (w: number, h: number) => void; onError?: () => void } = {};

function disableCanvasSink(reason: string): void {
  console.warn(`[video] off-thread MJPEG reader unavailable (${reason}) — using the <img> sink`);
  canvasSink.set(false);
  mjpegStats.set(null);
  worker?.postMessage({ type: 'stop' });
}

/** Called once from the video store so the reader can report a picture size (the surfaces size
 *  themselves from it) and a dead stream (which drives the existing reconnect). */
export function setMjpegSinkHandlers(h: typeof handlers): void {
  handlers = h;
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  let w: Worker;
  try {
    w = new Worker(new URL('./mjpegWorker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    disableCanvasSink(e instanceof Error ? e.message : String(e));
    return null;
  }
  w.onmessage = (e: MessageEvent<OutMessage>) => {
    const msg = e.data;
    if (msg.type === 'stats') {
      const { type: _t, ...stats } = msg;
      mjpegStats.set(stats);
    } else if (msg.type === 'size') {
      handlers.onSize?.(msg.width, msg.height);
    } else if (msg.everDrew) {
      console.warn('[video] MJPEG reader:', msg.message);
      handlers.onError?.();
    } else {
      // Never delivered a frame → this is the path failing, not the feed. Hand back to the <img>
      // sink, which then reports a genuine problem through its own error event.
      disableCanvasSink(msg.message);
    }
  };
  worker = w;
  return w;
}

export function startMjpegSink(url: string): void {
  if (!get(canvasSink)) return;
  ensureWorker()?.postMessage({ type: 'start', url });
}

export function stopMjpegSink(): void {
  worker?.postMessage({ type: 'stop' });
  mjpegStats.set(null);
}

/** Svelte action for a `<canvas>` video surface: hands the canvas to the reader for its lifetime.
 *  The element keeps whatever CSS its surface gives it — the backing store carries the source
 *  resolution and `object-fit` scales it, exactly as with the <img> it replaces. */
export function mjpegSink(node: HTMLCanvasElement) {
  const id = nextId++;
  try {
    const off = node.transferControlToOffscreen();
    ensureWorker()?.postMessage({ type: 'attach', id, canvas: off }, [off]);
  } catch (e) {
    disableCanvasSink(e instanceof Error ? e.message : String(e));
  }
  return {
    destroy() {
      worker?.postMessage({ type: 'detach', id });
    },
  };
}
