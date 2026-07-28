// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

/// <reference lib="webworker" />

// MJPEG multipart reader — runs OFF the main thread.
//
// Why this exists: an <img> fed from a multipart stream needs a main-thread rendering-lifecycle pass
// per frame (resource callback → paint invalidation → commit), and the decoded bitmaps live in the
// engine's image cache where we cannot influence their lifetime. A 720p feed pushes ~3.7 MB of RGBA
// per frame through that cache; at 50 fps the housekeeping alone produced multi-hundred-millisecond
// freezes. Measured against ffplay on the same stream (27.07.2026): 32.6 vs 49.9 fps displayed, 40.4 %
// of the time a still picture, worst freeze 667 ms — on Windows, so this is structural and not a
// WebKitGTK quirk. The H.264/WebRTC path was level with ffplay in the same series, because a <video>
// frame reaches the compositor without touching the main thread at all.
//
// So we do what a real player does: read the stream ourselves, decode off-thread, draw into
// OffscreenCanvases the surfaces hand over, and — crucially — DROP a frame that is already superseded
// instead of queueing it. Frame lifetime is explicit (`ImageBitmap.close()`), so no garbage collector
// is involved in the hot path.
//
// One reader serves every visible surface: previously each <img> opened its own HTTP stream and
// decoded independently.

/** A surface that has handed its canvas over (`transferControlToOffscreen`). */
interface Sink {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
}

type InMessage =
  | { type: 'start'; url: string }
  | { type: 'stop' }
  | { type: 'attach'; id: number; canvas: OffscreenCanvas }
  | { type: 'detach'; id: number };

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]);
const STATS_INTERVAL_MS = 1000;
const HEADER_DECODER = new TextDecoder();

/** Grace period before the last detached surface stops the stream. A map↔video swap destroys one
 *  canvas and creates another, which would otherwise tear the connection down and back up. */
const IDLE_STOP_MS = 1500;

const sinks = new Map<number, Sink>();

let abort: AbortController | null = null;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** The feed we are meant to be showing, independent of whether we are currently connected: with no
 *  visible surface we disconnect entirely, exactly as the `<img>` sinks did — go2rtc then stops the
 *  transcode, which is the expensive half on a small board. */
let wantUrl: string | null = null;
let everDrew = false;

/** The newest frame that has not been decoded yet. A second arrival while a decode is in flight
 *  replaces it — that is the drop-on-late behaviour, and the reason a busy machine falls behind in
 *  frame rate instead of in latency. */
let pending: Blob | null = null;
let decoding = false;

let frameW = 0;
let frameH = 0;
let lastFrameAt = 0;
let lastDrawAt = 0;
// Per-interval counters (reset on each stats post) and cumulative ones (kept for the whole run).
let arrived = 0;
let drawn = 0;
let bytes = 0;
let dropped = 0;
let corrupt = 0;
let statsAt = 0;
// The figures that separate the failure modes. A visible freeze is by definition a long gap between
// two *drawn* frames; whether the matching gap on the *arrival* side is just as long says whether we
// are looking at the source/network or at this machine's decoding.
let droppedNow = 0;
let gapIn = 0;
let gapDraw = 0;
let decodeSum = 0;
let decodeMax = 0;
let decodeCount = 0;

function post(message: unknown): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

/** First index of `needle` in `hay` at or after `from`, or -1. */
function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** `\r\n--<boundary>` from the response Content-Type, used only when a part omits Content-Length. */
function separatorOf(contentType: string | null): Uint8Array | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const b = m?.[1] ?? m?.[2];
  return b ? new TextEncoder().encode(`\r\n--${b}`) : null;
}

/** Body length from a part's header block: the byte count, or -1 when the part carries no
 *  Content-Length (then the body runs to the next boundary). ffmpeg's mpjpeg muxer spells the header
 *  `Content-length`, go2rtc `Content-Length` — hence the case-insensitive match. */
function bodyLength(head: Uint8Array): number {
  const m = /content-length:\s*(\d+)/i.exec(HEADER_DECODER.decode(head));
  return m?.[1] ? Number(m[1]) : -1;
}

function emit(view: Uint8Array): void {
  arrived++;
  const now = performance.now();
  if (lastFrameAt) gapIn = Math.max(gapIn, now - lastFrameAt);
  lastFrameAt = now;
  if (pending) {
    // Superseded before it could be decoded — exactly what we want under load.
    dropped++;
    droppedNow++;
  }
  pending = new Blob([view], { type: 'image/jpeg' });
  if (!decoding) void drain();
}

/** Decode and draw whatever is pending, newest first, until the queue of one runs dry. */
async function drain(): Promise<void> {
  decoding = true;
  try {
    while (pending) {
      const blob = pending;
      pending = null;
      let bmp: ImageBitmap;
      const t0 = performance.now();
      try {
        bmp = await createImageBitmap(blob);
      } catch {
        corrupt++; // a truncated frame must not take the stream down
        continue;
      }
      const decodeMs = performance.now() - t0;
      decodeSum += decodeMs;
      decodeCount++;
      if (decodeMs > decodeMax) decodeMax = decodeMs;
      if (bmp.width !== frameW || bmp.height !== frameH) {
        frameW = bmp.width;
        frameH = bmp.height;
        post({ type: 'size', width: frameW, height: frameH });
      }
      for (const s of sinks.values()) {
        // The backing store carries the source resolution and the element is scaled by CSS
        // (`object-fit`), exactly as the <img> was — no fit maths, no resize plumbing here.
        if (s.canvas.width !== frameW || s.canvas.height !== frameH) {
          s.canvas.width = frameW;
          s.canvas.height = frameH;
        }
        s.ctx.drawImage(bmp, 0, 0);
      }
      bmp.close(); // deterministic free — the whole point of doing this ourselves
      drawn++;
      everDrew = true;
      const now = performance.now();
      if (lastDrawAt) gapDraw = Math.max(gapDraw, now - lastDrawAt);
      lastDrawAt = now;
    }
  } finally {
    decoding = false;
  }
}

function postStats(): void {
  const now = performance.now();
  const dt = Math.max(1, now - statsAt) / 1000;
  statsAt = now;
  post({
    type: 'stats',
    fpsIn: arrived / dt,
    fpsOut: drawn / dt,
    kbps: (bytes * 8) / 1000 / dt,
    dropped,
    droppedNow,
    corrupt,
    gapIn,
    gapDraw,
    decodeAvgMs: decodeCount ? decodeSum / decodeCount : 0,
    decodeMaxMs: decodeMax,
    width: frameW,
    height: frameH,
    sinceFrameMs: lastFrameAt ? now - lastFrameAt : -1,
  });
  arrived = 0;
  drawn = 0;
  bytes = 0;
  droppedNow = 0;
  gapIn = 0;
  gapDraw = 0;
  decodeSum = 0;
  decodeMax = 0;
  decodeCount = 0;
}

async function run(url: string): Promise<void> {
  const ctl = new AbortController();
  abort = ctl;
  let buf = new Uint8Array(0);
  let headScan = 0; // resume point for the header search — keeps re-scans off the whole buffer
  let bodyScan = 0;
  let need = 0; // 0 = expecting a header block · >0 = fixed-length body · -1 = body runs to the boundary

  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const sep = separatorOf(res.headers.get('content-type'));
    const reader = res.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (ctl.signal.aborted) return;
      if (done) throw new Error('stream ended');
      bytes += value.byteLength;
      buf = buf.length ? append(buf, value) : value;

      for (;;) {
        if (need === 0) {
          const h = indexOfSeq(buf, CRLFCRLF, headScan);
          if (h < 0) {
            headScan = Math.max(0, buf.length - 3);
            break;
          }
          need = bodyLength(buf.subarray(0, h));
          buf = buf.subarray(h + 4);
          headScan = 0;
          bodyScan = 0;
        }
        if (need > 0) {
          if (buf.length < need) break;
          emit(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = 0;
        } else {
          // No Content-Length: the body ends at the next boundary, which we leave in the buffer so
          // the header search picks it up again.
          if (!sep) throw new Error('multipart stream without Content-Length or boundary');
          const e = indexOfSeq(buf, sep, bodyScan);
          if (e < 0) {
            bodyScan = Math.max(0, buf.length - sep.length + 1);
            break;
          }
          emit(buf.subarray(0, e));
          buf = buf.subarray(e);
          need = 0;
          bodyScan = 0;
        }
      }
    }
  } catch (e) {
    if (ctl.signal.aborted) return; // our own stop
    // `everDrew` decides how the main thread reads this: a failure before the first frame means this
    // path never worked here (a blocked cross-origin fetch looks exactly like this) and it falls back
    // to the <img> sink; a failure afterwards is a stream that died and drives the normal reconnect.
    post({ type: 'error', message: e instanceof Error ? e.message : String(e), everDrew });
  } finally {
    // Leave the worker connectable again — but only if nothing newer has taken over meanwhile.
    if (abort === ctl) {
      abort = null;
      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = undefined;
      }
    }
  }
}

/** Disconnect but keep `wantUrl` — a surface coming back restarts the stream. */
function disconnect(): void {
  abort?.abort();
  abort = null;
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = undefined;
  }
  pending = null;
}

function connect(): void {
  if (!wantUrl || abort || sinks.size === 0) return;
  frameW = 0;
  frameH = 0;
  lastFrameAt = 0;
  lastDrawAt = 0;
  arrived = 0;
  drawn = 0;
  bytes = 0;
  droppedNow = 0;
  gapIn = 0;
  gapDraw = 0;
  decodeSum = 0;
  decodeMax = 0;
  decodeCount = 0;
  statsAt = performance.now();
  statsTimer = setInterval(postStats, STATS_INTERVAL_MS);
  void run(wantUrl);
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'attach': {
      const ctx = msg.canvas.getContext('2d');
      if (!ctx) break;
      sinks.set(msg.id, { canvas: msg.canvas, ctx });
      clearTimeout(idleTimer);
      idleTimer = undefined;
      connect();
      break;
    }
    case 'detach':
      sinks.delete(msg.id);
      if (sinks.size === 0 && !idleTimer) idleTimer = setTimeout(disconnect, IDLE_STOP_MS);
      break;
    case 'start':
      disconnect();
      wantUrl = msg.url;
      dropped = 0;
      corrupt = 0;
      connect();
      break;
    case 'stop':
      wantUrl = null;
      disconnect();
      break;
  }
};
