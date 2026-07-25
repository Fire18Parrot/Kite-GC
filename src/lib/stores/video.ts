// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

// Embedded video — source router with three kinds:
//   • camera — local webcam / USB capture via getUserMedia (the zero-dependency default).
//   • rtsp   — network stream via the go2rtc engine (WebRTC, MJPEG fallback).
//   • native — the OS hardware capture layer via ffmpeg (Linux V4L2 / Windows DirectShow / macOS
//              AVFoundation) → embedded MJPEG server, rendered in an <img>. The "Advanced" tier with
//              device-verified codec/resolution/framerate control (see helpers/videoCapabilities.ts).
//
// The router opens a source once and exposes its MediaStream; multiple sinks
// (the NavRail panel preview, the dock widget, the floating window, the
// map-swap view) bind the *same* stream to their own <video> element — a
// MediaStream attaches to many elements at once, so one decode feeds them all.
// (native is the exception: an MJPEG multipart feed rendered per-<img>.)
//
// `getUserMedia` works in WebView2 (Windows) and WebKitGTK (Linux) and, with the camera entitlement,
// WKWebView (macOS), so the camera path needs no backend. rtsp + native use the Rust backend.

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { t } from 'svelte-i18n';
import { isLinux } from '$lib/platform';
import {
  type NativeDevice,
  type CaptureMode,
  type NativeSelection,
  validateSelection,
} from '$lib/helpers/videoCapabilities';

export interface VideoDevice {
  deviceId: string;
  label: string;
}

export type VideoStatus = 'off' | 'starting' | 'live' | 'error';
export type VideoResolution = 'auto' | '720p' | '1080p';
/** getUserMedia framerate wish (the camera path can't enumerate modes, only hint a rate). */
export type CameraFps = 'auto' | '30' | '60';
/** Source kind: local camera (getUserMedia MediaStream), RTSP bridge (go2rtc), or native hardware
 *  capture (V4L2 / DirectShow / AVFoundation → embedded MJPEG server). */
export type VideoKind = 'camera' | 'rtsp' | 'native';
/** Which go2rtc reader served the live RTSP feed: native client or the ffmpeg fallback. */
export type RtspEngine = 'native' | 'ffmpeg' | null;
/** RTSP transport for a connection. 'udp' → ffmpeg reader (reads UDP-only servers like the UAV-Link
 *  Pi); 'tcp' → go2rtc's native RTP-over-TCP client; 'auto' → native first, then the ffmpeg fallback. */
export type RtspTransport = 'udp' | 'tcp' | 'auto';
/** A saved, named RTSP connection the user can recall from the connection list (see VideoPanel). */
export interface RtspConnection {
  id: string;
  name: string;
  url: string;
  transport: RtspTransport;
}
/** Where the single map instance currently lives (the inverse of which surfaces show video). */
export type MapLocation = 'main' | 'floating' | 'widget';

export interface VideoState {
  /** Active source kind. `camera` → getUserMedia MediaStream; `rtsp` → go2rtc (WebRTC or MJPEG);
   *  `native` → embedded MJPEG server rendered in an `<img>`. */
  kind: VideoKind;
  /** User wants video on (source open). */
  enabled: boolean;
  status: VideoStatus;
  devices: VideoDevice[];
  /** Selected video input device (null = system default). */
  deviceId: string | null;
  resolution: VideoResolution;
  /** getUserMedia framerate wish (camera path). */
  cameraFps: CameraFps;
  // ── Native capture (Advanced) ────────────────────────────────────
  /** Native capture devices (V4L2/DirectShow/AVFoundation) — enumerated by the Rust backend. */
  nativeDevices: NativeDevice[];
  /** Selected native device id (V4L2 path / DirectShow name / AVFoundation index), null if none. */
  nativeDevice: string | null;
  /** Name of the selected native device — the tie-breaker when the id turns out to be unstable
   *  (AVFoundation index / `/dev/videoN` both renumber on re-plug). See `resolveNativeDevice`. */
  nativeDeviceName: string | null;
  /** Probed modes for the selected native device (drives the format→resolution→framerate cascade). */
  nativeModes: CaptureMode[];
  /** Chosen native capture config (format/resolution/framerate). */
  nativeSel: NativeSelection;
  // ── RTSP source ──────────────────────────────────────────────────
  /** RTSP URL (e.g. rtsp://192.168.1.10:554/live) — the active/direct-connect URL. */
  rtspUrl: string;
  /** Transport for the active RTSP connection (udp/tcp/auto). */
  rtspTransport: RtspTransport;
  /** Saved, named RTSP connections the user can recall (explicit save — never auto-added). */
  rtspConnections: RtspConnection[];
  /** Active RTSP reader once live (native go2rtc client vs ffmpeg fallback); runtime-only. */
  rtspEngine: RtspEngine;
  /** Runtime-only: true while the infinite RTSP auto-reconnect loop is running (link dropped/stalled). */
  reconnecting: boolean;
  /** Runtime-only: current reconnect attempt number, shown in the on-video overlay. */
  reconnectAttempt: number;
  /** go2rtc MJPEG HTTP URL for systems where RTCPeerConnection is unavailable. */
  mjpegUrl: string | null;
  /** Mirror horizontally (front-facing cams) — applied by the display sinks. */
  mirror: boolean;
  /** Source aspect ratio (w/h); drives the widget / floating-window sizing. */
  aspect: number;
  /** Negotiated track settings (for the info line); null until live. */
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /** Max frame rate the camera *reports* it can do at the chosen mode (diagnostic). */
  capFrameRate: number | null;
  error: string | null;

  // ── Floating window ──────────────────────────────────────────────
  /** Floating video window visible. */
  floating: boolean;
  /** Snapped to the bottom-left corner (displaces the dock) vs free-floating. */
  floatSnapped: boolean;
  /** Free position (px from top-left of the app window), used when not snapped. */
  floatX: number;
  floatY: number;
  /** Window height as a fraction of the viewport height (0.1…0.3); width = height·aspect. */
  floatHeightFrac: number;
  /** Where the single map instance currently lives (transient, not persisted). `main` = the normal
   *  full-screen map; `floating`/`widget` = the map jumped into that video surface (which double-
   *  clicked), and every other surface shows video. Double-clicking a video moves the map there. */
  mapLocation: MapLocation;
  /** Screen rect (px) of the video widget tile, published by the widget — used to overlay the map
   *  onto it when `mapLocation === 'widget'`. Null until measured. */
  widgetRect: { x: number; y: number; w: number; h: number } | null;
}

// ── Persistence ─────────────────────────────────────────────────────
// Self-contained (own localStorage key, same mechanism as the app settings
// store): we remember the device/resolution/mirror selection and whether video
// was running, so it can auto-start with the last settings on the next launch.
const STORAGE_KEY = 'kite-gc-video';

interface VideoPrefs {
  kind: VideoKind;
  enabled: boolean;
  deviceId: string | null;
  resolution: VideoResolution;
  cameraFps: CameraFps;
  rtspUrl: string;
  rtspTransport: RtspTransport;
  rtspConnections: RtspConnection[];
  nativeDevice: string | null;
  nativeDeviceName: string | null;
  nativeWidth: number;
  nativeHeight: number;
  nativeFps: number;
  mirror: boolean;
  floating: boolean;
  floatSnapped: boolean;
  floatX: number;
  floatY: number;
  floatHeightFrac: number;
}

const PREF_DEFAULTS: VideoPrefs = {
  kind: 'camera',
  enabled: false,
  deviceId: null,
  resolution: 'auto',
  cameraFps: 'auto',
  rtspUrl: '',
  rtspTransport: 'auto',
  rtspConnections: [],
  nativeDevice: null,
  nativeDeviceName: null,
  nativeWidth: 1280,
  nativeHeight: 720,
  nativeFps: 30,
  mirror: false,
  floating: false,
  floatSnapped: true,
  floatX: 16,
  floatY: 80,
  floatHeightFrac: 0.2,
};

function loadPrefs(): VideoPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as Partial<VideoPrefs> & { v4l2Device?: string | null };
      // Pre-1.0 hard-switch: the old Linux-only 'v4l2' kind is now the generic 'native' kind.
      const kind = ((p.kind as string) === 'v4l2' ? 'native' : p.kind ?? 'camera') as VideoKind;
      return {
        ...PREF_DEFAULTS,
        ...p,
        kind,
        deviceId: p.deviceId ?? null,
        resolution: p.resolution ?? 'auto',
        cameraFps: p.cameraFps ?? 'auto',
        rtspUrl: p.rtspUrl ?? '',
        rtspTransport: p.rtspTransport ?? 'auto',
        rtspConnections: Array.isArray(p.rtspConnections) ? p.rtspConnections : [],
        nativeDevice: p.nativeDevice ?? p.v4l2Device ?? null,
        nativeDeviceName: p.nativeDeviceName ?? null,
        nativeWidth: p.nativeWidth ?? 1280,
        nativeHeight: p.nativeHeight ?? 720,
        nativeFps: p.nativeFps ?? 30,
      };
    }
  } catch {
    /* ignore */
  }
  return { ...PREF_DEFAULTS };
}

function savePrefs(): void {
  if (typeof localStorage === 'undefined') return;
  const s = get(videoState);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        kind: s.kind,
        enabled: s.enabled,
        deviceId: s.deviceId,
        resolution: s.resolution,
        cameraFps: s.cameraFps,
        rtspUrl: s.rtspUrl,
        rtspTransport: s.rtspTransport,
        rtspConnections: s.rtspConnections,
        nativeDevice: s.nativeDevice,
        nativeDeviceName: s.nativeDeviceName,
        nativeWidth: s.nativeSel.width,
        nativeHeight: s.nativeSel.height,
        nativeFps: s.nativeSel.fps,
        mirror: s.mirror,
        floating: s.floating,
        floatSnapped: s.floatSnapped,
        floatX: s.floatX,
        floatY: s.floatY,
        floatHeightFrac: s.floatHeightFrac,
      }),
    );
  } catch {
    /* ignore */
  }
}

const boot = loadPrefs();

const INITIAL: VideoState = {
  kind: boot.kind,
  enabled: false, // runtime flag — auto-start (below) decides whether to turn on
  status: 'off',
  devices: [],
  deviceId: boot.deviceId,
  resolution: boot.resolution,
  cameraFps: boot.cameraFps,
  nativeDevices: [],
  nativeDevice: boot.nativeDevice,
  nativeDeviceName: boot.nativeDeviceName,
  nativeModes: [],
  nativeSel: {
    width: boot.nativeWidth,
    height: boot.nativeHeight,
    fps: boot.nativeFps,
  },
  rtspUrl: boot.rtspUrl,
  rtspTransport: boot.rtspTransport,
  rtspConnections: boot.rtspConnections,
  rtspEngine: null,
  reconnecting: false,
  reconnectAttempt: 0,
  mjpegUrl: null,
  mirror: boot.mirror,
  aspect: 16 / 9,
  width: null,
  height: null,
  frameRate: null,
  capFrameRate: null,
  error: null,
  floating: boot.floating,
  floatSnapped: boot.floatSnapped,
  floatX: boot.floatX,
  floatY: boot.floatY,
  floatHeightFrac: boot.floatHeightFrac,
  mapLocation: 'main',
  widgetRect: null,
};

export const videoState = writable<VideoState>({ ...INITIAL });

/**
 * The single live MediaStream that every sink renders. For `camera` it is the
 * `getUserMedia` stream; for `rtsp` it is the `captureStream()` of a hidden driver
 * `<video>` that plays the loopback feed (see startRtsp). Either way a MediaStream
 * attaches to many `<video>` elements at once, so one decode/connection feeds all
 * sinks — and the RTSP feed has exactly one ffmpeg/loopback connection.
 */
export const videoStream = writable<MediaStream | null>(null);

function patch(p: Partial<VideoState>): void {
  videoState.update((s) => ({ ...s, ...p }));
}

/** Mirror a video-pipeline event into the **backend log file** (and the console).
 *
 *  The whole source router — including the RTSP reconnect loop and its stall detection — runs here in
 *  the frontend, so until now the answer to "why did the stream drop?" existed only as a `console.warn`
 *  in DevTools. A tester on a Raspberry Pi has neither: a release build has no console, and the log file
 *  the Diagnostics page hands out never saw a word of it. Stream aborts go in at **warn**, so they show
 *  up at the default log level; routine lifecycle detail is `info` (captured at Debug). */
function logVideo(level: 'warn' | 'info', message: string): void {
  if (level === 'warn') console.warn(`[video] ${message}`);
  else console.log(`[video] ${message}`);
  void invoke('log_frontend', { level, area: 'video', message }).catch(() => {});
}

/** Bind a sink's `<video>` element to the shared MediaStream (camera or rtsp). */
export function bindVideoEl(el: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (!el) return;
  el.srcObject = stream;
}

/** Report the natural size of the live source (from a sink's `loadedmetadata`) so the
 *  floating window / widget can size to the real aspect ratio (RTSP has no upfront caps). */
export function reportVideoSize(width: number, height: number): void {
  if (!width || !height) return;
  patch({ width, height, aspect: width / height });
}

const RES_DIMS: Record<VideoResolution, MediaTrackConstraints> = {
  auto: {},
  '720p': { width: { ideal: 1280 }, height: { ideal: 720 } },
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 } },
};

// Without a frameRate hint the browser may negotiate an uncompressed camera mode (YUY2/NV12) that is
// USB-bandwidth-limited to a few fps at high resolution. There is no way to request MJPEG directly, so
// a high ideal rate (60, the FPV standard) nudges the browser toward the camera's MJPEG mode. The
// `native` source is the real fix when the browser still won't deliver. 'auto' keeps the 60 nudge; an
// explicit 30 asks for the lower rate.
//
// On Linux/WebKitGTK the browser SOFTWARE-decodes every frame and composites it through a Wayland
// subsurface, so an uncapped 'auto' at 60 fps saturates the WebKit process and freezes the whole app
// on weak hardware. There we bound decode load: 'auto' caps to 720p (never uncapped) and the fps ideal
// never exceeds 30. (The `native` source additionally routes through the ffmpeg/MJPEG path on Linux.)
function cameraConstraints(res: VideoResolution, fps: CameraFps): MediaTrackConstraints {
  const dims = res === 'auto' && isLinux ? RES_DIMS['720p'] : RES_DIMS[res];
  const ideal = fps === '30' ? 30 : isLinux ? 30 : 60;
  return { ...dims, frameRate: { ideal } };
}

function mediaDevicesAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** Check if RTCPeerConnection is available (WebRTC support in the WebView). */
export function isWebrtcAvailable(): boolean {
  return typeof RTCPeerConnection !== 'undefined';
}

/** Build the go2rtc MJPEG URL from the running engine's API port. */
async function buildMjpegUrl(): Promise<string> {
  const port = await invoke<number | null>('video_go2rtc_port');
  if (!port) throw new Error('go2rtc not running');
  return `http://127.0.0.1:${port}/api/stream.mjpeg?src=kite`;
}

/** Start a native device via the built-in MJPEG server (no go2rtc dependency). Used only as the
 *  fallback for devices getUserMedia can't expose — codec is left to ffmpeg (`auto`). */
async function startNativeMjpeg(sel: NativeSelection, id: string): Promise<string> {
  return await invoke<string>('video_native_mjpeg_start', {
    id,
    codec: 'auto',
    width: sel.width,
    height: sel.height,
    fps: sel.fps,
  });
}

/** Stop the built-in MJPEG server. */
async function stopNativeMjpeg(): Promise<void> {
  await invoke('video_native_mjpeg_stop').catch(() => {});
}

/** Normalize a device name/label for cross-API matching (OS device name ↔ getUserMedia label). Drops
 *  parenthesised suffixes (USB ids like "(046d:0825)", bus paths) and non-alphanumerics, which differ
 *  wildly between the V4L2 sysfs name and the WebKitGTK/Chromium label for the same camera. */
function normalizeDeviceName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map a probed native device to a getUserMedia `deviceId` so we can stream it through the clean
 *  hardware `<video>` path. Returns null only when getUserMedia genuinely can't expose the device
 *  (→ the caller uses the ffmpeg/MJPEG fallback). Bootstraps a one-off permission grant if labels
 *  aren't populated yet. */
async function findGetUserMediaId(nativeId: string): Promise<string | null> {
  if (!mediaDevicesAvailable()) return null;
  const dev = get(videoState).nativeDevices.find((d) => d.id === nativeId);
  const want = dev ? normalizeDeviceName(dev.name) : '';

  const inputs = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  let cams = await inputs();
  if (cams.every((c) => !c.label)) {
    // Labels need a prior permission grant — request one, release it, then re-enumerate.
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const t of tmp.getTracks()) t.stop();
      cams = await inputs();
    } catch {
      return null;
    }
  }

  let match = want
    ? (cams.find((c) => normalizeDeviceName(c.label) === want) ??
       cams.find((c) => {
         const l = normalizeDeviceName(c.label);
         return l && (l.includes(want) || want.includes(l));
       }))
    : undefined;
  // Robust fallback: a single-camera system (the laptop case) is unambiguous even when the V4L2 name
  // and the getUserMedia label don't textually match — the name formats differ a lot on Linux.
  if (!match && cams.length === 1 && cams[0].deviceId) match = cams[0];

  console.log('[video] native→getUserMedia match', {
    want,
    labels: cams.map((c) => c.label),
    matched: match?.label ?? null,
  });
  return match?.deviceId ?? null;
}

/** Open a native device through getUserMedia (a hardware `<video>` MediaStream). Degrades gracefully:
 *  `exact` resolution/framerate first (honour the selection on Chromium/WebView2), then `ideal`
 *  (WebKitGTK's getUserMedia throws OverconstrainedError on `exact` it can't meet 1:1 — `ideal` is
 *  what the plain camera path uses and never throws), then a bare device open. Throws only if every
 *  attempt fails. */
async function getNativeUserMedia(deviceId: string, sel: NativeSelection): Promise<MediaStream> {
  const dev: ConstrainDOMString = { exact: deviceId };
  const attempts: MediaTrackConstraints[] = [
    { deviceId: dev, width: { exact: sel.width }, height: { exact: sel.height }, frameRate: { exact: sel.fps } },
    { deviceId: dev, width: { ideal: sel.width }, height: { ideal: sel.height }, frameRate: { ideal: sel.fps } },
    { deviceId: dev },
  ];
  let lastErr: unknown;
  for (const video of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      lastErr = e;
      console.warn('[video] native getUserMedia attempt failed', video, e);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Enumerate video input devices. Labels are only populated once permission has
 *  been granted (i.e. after the first successful getUserMedia). */
export async function enumerateVideoDevices(): Promise<void> {
  if (!mediaDevicesAvailable()) {
    patch({ error: 'Camera API unavailable' });
    return;
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    patch({ devices });
    // Drop a stale selection that no longer exists.
    const sel = get(videoState).deviceId;
    if (sel && !devices.some((d) => d.deviceId === sel)) patch({ deviceId: null });
  } catch (e) {
    patch({ error: `Device enumeration failed: ${e}` });
  }
}

/** Re-resolve the persisted native device against a fresh enumeration.
 *
 *  Device ids are only stable up to a point: AVFoundation hands out a running **index** (`"0"`, `"1"`)
 *  and V4L2 a `/dev/videoN` path — both renumber when hardware is re-plugged or the machine reboots, so
 *  a saved id can silently denote a *different* camera. Checking "does the id still exist" (the old
 *  behaviour) can't see that. The saved name is the tie-breaker: keep the id while it still names the
 *  same device, otherwise follow the name to its new id, and only fall back to the first device when
 *  neither matches. */
function resolveNativeDevice(
  devices: NativeDevice[],
  id: string | null,
  name: string | null,
): NativeDevice | null {
  if (devices.length === 0) return null;
  const byId = id ? devices.find((d) => d.id === id) : undefined;
  if (byId && (!name || byId.name === name)) return byId;
  const byName = name ? devices.find((d) => d.name === name) : undefined;
  return byName ?? byId ?? devices[0];
}

/** Enumerate native capture devices via the Rust backend (V4L2/DirectShow/AVFoundation), then repair
 *  the persisted selection against the fresh list (see `resolveNativeDevice`). */
export async function enumerateNativeDevices(): Promise<void> {
  try {
    const devices = await invoke<NativeDevice[]>('video_list_native_devices');
    patch({ nativeDevices: devices });
    const st = get(videoState);
    const want = resolveNativeDevice(devices, st.nativeDevice, st.nativeDeviceName);
    if (!want) {
      if (st.nativeDevice) patch({ nativeDevice: null, nativeDeviceName: null, nativeModes: [] });
      return;
    }
    if (want.id !== st.nativeDevice) {
      // Genuinely a different device (first run, hardware swapped, or the id moved) → full switch.
      await setNativeDevice(want.id);
    } else {
      // Same device: only backfill the name (nothing to restart) and refresh its modes.
      if (want.name !== st.nativeDeviceName) patch({ nativeDeviceName: want.name });
      await probeNativeDevice(want.id);
    }
  } catch {
    // Native capture not available (no ffmpeg / unsupported platform) — that's fine.
    patch({ nativeDevices: [] });
  }
}

/** Probe the selected device's supported modes and repair the current selection against them. An
 *  empty probe (macOS / ffmpeg missing) keeps the persisted selection and the full curated catalog. */
export async function probeNativeDevice(id: string): Promise<void> {
  let modes: CaptureMode[] = [];
  try {
    modes = await invoke<CaptureMode[]>('video_probe_device', { id });
  } catch {
    modes = [];
  }
  const cur = get(videoState).nativeSel;
  const sel = modes.length === 0 ? cur : validateSelection(modes, cur);
  patch({ nativeModes: modes, nativeSel: sel });
  savePrefs();
}

function stopTracks(): void {
  const s = get(videoStream);
  if (s) for (const tr of s.getTracks()) tr.stop();
  videoStream.set(null);
  closeRtc();
}

// ── RTSP via WebRTC (go2rtc) ─────────────────────────────────────────
// go2rtc ingests the RTSP source and republishes it as WebRTC: the browser negotiates a
// peer connection (SDP exchange proxied through Rust to avoid CORS) and gets a real, native,
// low-latency MediaStream — which slots straight into the shared `videoStream` so every sink
// renders it via srcObject exactly like the camera (no fMP4/MSE/captureStream gymnastics).
let rtcConn: RTCPeerConnection | null = null;

function closeRtc(): void {
  if (!rtcConn) return;
  const pc = rtcConn;
  rtcConn = null;
  try {
    pc.getReceivers().forEach((r) => r.track?.stop());
    pc.close();
  } catch {
    /* ignore */
  }
}

/** Resolve once ICE gathering completes (or a short timeout) — HTTP signaling can't trickle,
 *  so the offer must already carry candidates; on loopback they gather almost instantly. */
function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, 800);
  });
}

/** Open (or re-open) the webcam with the current device/resolution selection. */
export async function startVideo(): Promise<void> {
  if (!mediaDevicesAvailable()) {
    patch({ enabled: true, status: 'error', error: 'Camera API unavailable' });
    return;
  }
  stopTracks();
  patch({ kind: 'camera', enabled: true, status: 'starting', error: null });
  savePrefs(); // remember the intent immediately
  const st = get(videoState);
  const base: MediaTrackConstraints = cameraConstraints(st.resolution, st.cameraFps);
  try {
    let stream: MediaStream;
    try {
      const video: MediaTrackConstraints = { ...base };
      if (st.deviceId) video.deviceId = { exact: st.deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      // Saved device gone / busy / over-constrained → fall back to the default
      // device (e.g. the camera was unplugged or is on another machine).
      const name = e instanceof Error ? e.name : '';
      if (st.deviceId && ['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(name)) {
        patch({ deviceId: null });
        savePrefs();
        stream = await navigator.mediaDevices.getUserMedia({ video: { ...base }, audio: false });
      } else {
        throw e;
      }
    }
    videoStream.set(stream);
    const track = stream.getVideoTracks()[0];
    const s = track?.getSettings();
    const caps = track?.getCapabilities?.() as MediaTrackCapabilities | undefined;
    const aspect = s?.width && s?.height ? s.width / s.height : get(videoState).aspect;
    // Diagnostic: log the camera's full capability set so we can see whether a
    // high-fps (MJPEG) mode is even being offered to the browser.
    console.log('[video] track settings', s, 'capabilities', caps);
    patch({
      status: 'live',
      aspect,
      width: s?.width ?? null,
      height: s?.height ?? null,
      frameRate: s?.frameRate ?? null,
      capFrameRate: caps?.frameRate?.max ?? null,
      error: null,
    });
    // Labels are available now → refresh the device list.
    await enumerateVideoDevices();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    patch({ status: 'error', error: err });
  }
}

/** Register the source with go2rtc and complete one WebRTC negotiation. Throws on failure. */
async function negotiateWebrtc(url: string, useFfmpeg: boolean): Promise<void> {
  await invoke('video_webrtc_start', { url, useFfmpeg, mjpeg: false });

  const pc = new RTCPeerConnection({ iceServers: [] });
  rtcConn = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (e) => {
    if (rtcConn !== pc) return;
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    videoStream.set(stream);
    patch({ status: 'live', error: null });
  };
  pc.onconnectionstatechange = () => {
    // A genuine drop (failed) enters the infinite reconnect loop; 'closed' is our own teardown.
    if (rtcConn === pc && pc.connectionState === 'failed') {
      logVideo('warn', 'WebRTC peer connection failed');
      scheduleRtspReconnect();
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc);
  if (rtcConn !== pc) return; // stopped while gathering
  const answerSdp = await invoke<string>('video_webrtc_offer', {
    sdp: pc.localDescription?.sdp ?? offer.sdp,
  });
  if (rtcConn !== pc) return;
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  patch({ rtspEngine: useFfmpeg ? 'ffmpeg' : 'native' });
}

// ── RTSP auto-reconnect (infinite until frames return or the user stops) ──────────────────────────
// The UAV-Link Pi is UDP-only with a "session lottery" (its FPS-watchdog EOSes bad sessions), and a
// flying aircraft can drop into a radio hole. So the client reconnects INDEFINITELY and visibly until
// frames flow again — only an explicit stop ends it. Trigger: a frame timeout (no new frames/bytes on
// the WebRTC inbound track for RTSP_STALL_MS). UDP stays (latency over resends, per the UAV-Link design).
// Two-phase stall detection (LTE-tested against the UAV-Link Pi):
// - CONNECT phase (no frame seen yet): a fresh session that delivers nothing is a losing ticket in
//   the server's session lottery → re-roll fast (also beats the Pi watchdog's ~10 s kill window).
// - LIVE phase (frames were flowing): brief UDP gaps (LTE fluctuation) recover in-stream on their
//   own — only a sustained silence means the session really died (watchdog EOS / radio hole).
const RTSP_STALL_CONNECT_MS = 4000;
const RTSP_STALL_LIVE_MS = 10_000;
const RTSP_RECONNECT_BACKOFF_MS = 1500;
let rtspMonitor: ReturnType<typeof setInterval> | undefined;
let rtspReconnectTimer: ReturnType<typeof setTimeout> | undefined;

function clearRtspTimers(): void {
  if (rtspMonitor) { clearInterval(rtspMonitor); rtspMonitor = undefined; }
  if (rtspReconnectTimer) { clearTimeout(rtspReconnectTimer); rtspReconnectTimer = undefined; }
}

/** Watch the inbound WebRTC stats; if frames/bytes stop advancing the link has stalled → reconnect.
 *  Two-phase: 4 s until the FIRST frames arrive (dead session → re-roll fast), 10 s once the stream
 *  was delivering (tolerate transient UDP gaps before a full reconnect). */
function startRtspStallMonitor(pc: RTCPeerConnection): void {
  if (rtspMonitor) clearInterval(rtspMonitor);
  let last = -1;
  let sawFrames = false;
  let lastChange = performance.now();
  let warnedNoReport = false;
  rtspMonitor = setInterval(() => {
    if (rtcConn !== pc) { if (rtspMonitor) { clearInterval(rtspMonitor); rtspMonitor = undefined; } return; }
    void pc.getStats().then((stats) => {
      if (rtcConn !== pc) return;
      let frames = 0;
      let bytes = 0;
      let sawReport = false;
      stats.forEach((report) => {
        if (report.type !== 'inbound-rtp') return;
        // WebKit has historically reported the legacy `mediaType` instead of the spec's `kind`, and a
        // report carrying neither is counted too: mistaking a healthy feed for a dead one would put the
        // stream into a permanent reconnect loop, which is far worse than a missed stall.
        const rr = report as RTCInboundRtpStreamStats & { mediaType?: string };
        const kind = rr.kind ?? rr.mediaType;
        if (kind && kind !== 'video') return;
        sawReport = true;
        frames += rr.framesReceived ?? 0;
        bytes += rr.bytesReceived ?? 0;
      });
      if (!sawReport) {
        // No inbound stats at all — we cannot measure, so we must not judge. Say so once.
        if (!warnedNoReport) {
          warnedNoReport = true;
          logVideo('warn', 'RTSP stall monitor: no inbound-rtp stats from this WebView — stall detection is inactive');
        }
        return;
      }
      const progress = frames || bytes;
      const now = performance.now();
      if (progress !== last) {
        if (last >= 0 && progress > last) sawFrames = true; // real advance, not the initial read
        last = progress;
        lastChange = now;
      } else if (now - lastChange > (sawFrames ? RTSP_STALL_LIVE_MS : RTSP_STALL_CONNECT_MS)) {
        // The frames/bytes pair is the diagnosis: bytes > 0 with frames == 0 means the media arrives
        // but nothing decodes it (a missing H.264 decoder in the WebView's GStreamer stack); bytes == 0
        // means nothing arrives at all (transport / source).
        logVideo(
          'warn',
          `RTSP stalled after ${((now - lastChange) / 1000).toFixed(1)}s ` +
            `(${sawFrames ? 'live feed went silent' : 'no first frame'}; ` +
            `framesReceived=${frames} bytesReceived=${bytes}) — reconnecting`,
        );
        scheduleRtspReconnect();
      }
    }).catch(() => {});
  }, 1000);
}

/** Enter/continue the infinite reconnect loop: mark the visible reconnecting state and re-attempt
 *  after a short backoff. Guarded so an explicit stop (kind changed / disabled) ends it. */
function scheduleRtspReconnect(): void {
  const st = get(videoState);
  if (st.kind !== 'rtsp' || !st.enabled) return; // user stopped → do not reconnect
  // The loop is unbounded by design, so logging every attempt would fill the file on a source that
  // never comes back. Log the first few, then every tenth — enough to see it is still going.
  const attempt = st.reconnectAttempt + 1;
  if (attempt <= 3 || attempt % 10 === 0) {
    logVideo('warn', `RTSP reconnect attempt ${attempt} (${st.rtspUrl}, transport=${st.rtspTransport})`);
  }
  clearRtspTimers();
  closeRtc();
  videoStream.set(null);
  patch({
    reconnecting: true,
    reconnectAttempt: st.reconnectAttempt + 1,
    status: 'starting',
    rtspEngine: null,
    mjpegUrl: null,
  });
  rtspReconnectTimer = setTimeout(() => { void startRtsp({ reconnect: true }); }, RTSP_RECONNECT_BACKOFF_MS);
}

/** Negotiate the RTSP source honouring the connection's transport: udp → ffmpeg reader (reads
 *  UDP-only servers like the UAV-Link Pi); tcp → native go2rtc client; auto → native, then ffmpeg. */
async function negotiateRtsp(url: string, transport: RtspTransport): Promise<void> {
  if (transport === 'udp') {
    await negotiateWebrtc(url, true);
  } else if (transport === 'tcp') {
    await negotiateWebrtc(url, false);
  } else {
    try {
      await negotiateWebrtc(url, false); // native go2rtc RTSP client
    } catch (nativeErr) {
      logVideo('warn', `native go2rtc RTSP reader failed, retrying via ffmpeg: ${nativeErr instanceof Error ? nativeErr.message : String(nativeErr)}`);
      closeRtc();
      if (get(videoState).kind !== 'rtsp' || !get(videoState).enabled) return; // stopped meanwhile
      await negotiateWebrtc(url, true); // ffmpeg reader fallback
    }
  }
}

/** Open (or re-open) the RTSP feed via go2rtc, honouring the active transport. Once live, a stall
 *  monitor watches for frame timeouts; any failure/drop enters the infinite reconnect loop (until
 *  frames return or the user stops). `reconnect` distinguishes a loop retry from a fresh start. */
export async function startRtsp(opts?: { reconnect?: boolean }): Promise<void> {
  const reconnect = opts?.reconnect ?? false;
  clearRtspTimers();
  stopTracks(); // release the camera / previous peer connection
  const st = get(videoState);
  const url = st.rtspUrl.trim();
  const transport = st.rtspTransport;
  if (!url) {
    patch({ kind: 'rtsp', enabled: true, status: 'error', error: 'No RTSP URL', reconnecting: false, reconnectAttempt: 0 });
    return;
  }
  patch({
    kind: 'rtsp',
    enabled: true,
    status: 'starting',
    error: null,
    rtspEngine: null,
    mjpegUrl: null,
    ...(reconnect ? {} : { reconnecting: false, reconnectAttempt: 0 }),
  });
  if (!reconnect) savePrefs();

  if (!reconnect) {
    // A missing engine cannot be fixed by retrying, so it must not enter the loop: before this, an
    // auto-start without go2rtc installed produced an endless "Reconnecting… (n)" with no explanation
    // (seen on the Pi). Checked once per fresh start — a reconnect attempt inherits the verdict.
    const engine = await invoke<string | null>('video_go2rtc_status').catch(() => null);
    if (!engine) {
      logVideo('warn', 'RTSP start aborted: the go2rtc engine is not installed');
      patch({ status: 'error', error: get(t)('video.engineMissing'), reconnecting: false, reconnectAttempt: 0 });
      return;
    }
    logVideo(
      'info',
      `RTSP start ${url} (transport=${transport}, webrtc=${isWebrtcAvailable()}, engine=${engine})`,
    );
  }

  // MJPEG fallback for webviews without RTCPeerConnection (rare in Tauri). Reader choice: keep the
  // native go2rtc client for auto/tcp (the pre-connection-list behaviour — works without ffmpeg);
  // only an explicit UDP selection routes through the ffmpeg reader (needs ffmpeg, like the normal
  // UDP path).
  if (!isWebrtcAvailable()) {
    // Degraded mode, and a silent one: it needs go2rtc to transcode to MJPEG and a WebView that renders
    // multipart images. Worth a warning every time, not just a console line.
    if (!reconnect) {
      logVideo('warn', 'WebRTC is unavailable in this WebView — falling back to the MJPEG image path');
    }
    // Serving MJPEG means go2rtc has to TRANSCODE (an H.264 camera carries no MJPEG track), and that
    // needs ffmpeg. Missing ffmpeg makes the endpoint fail instantly — a dead end no reconnect fixes.
    const ffmpeg = await invoke<string | null>('video_ffmpeg_status').catch(() => null);
    if (!ffmpeg) {
      logVideo('warn', 'MJPEG fallback needs ffmpeg for transcoding and it is not installed');
      patch({ status: 'error', error: get(t)('video.ffmpegNativeMissing'), reconnecting: false, reconnectAttempt: 0 });
      return;
    }
    try {
      await invoke('video_webrtc_start', { url, useFfmpeg: transport === 'udp', mjpeg: true });
      const mjpegUrl = await buildMjpegUrl();
      patch({ status: 'live', mjpegUrl, error: null, rtspEngine: 'native', reconnecting: false, reconnectAttempt: 0 });
    } catch (e) {
      logVideo('warn', `RTSP (MJPEG fallback) failed: ${e instanceof Error ? e.message : String(e)}`);
      scheduleRtspReconnect();
    }
    return;
  }

  try {
    // Hard cap on one attempt: the backend invokes are bounded (10/15 s reqwest timeouts), but if
    // any path ever hangs anyway, the loop must keep cycling instead of freezing mid-"Reconnecting…"
    // (a wedged RTSP server once parked go2rtc's answer indefinitely — observed with the UAV-Link Pi).
    await Promise.race([
      negotiateRtsp(url, transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('RTSP negotiation timeout')), 20_000),
      ),
    ]);
    if (get(videoState).kind !== 'rtsp' || !get(videoState).enabled) return; // stopped during negotiation
    patch({ reconnecting: false, reconnectAttempt: 0 });
    if (rtcConn) startRtspStallMonitor(rtcConn);
  } catch (err) {
    logVideo('warn', `RTSP connect failed: ${err instanceof Error ? err.message : String(err)}`);
    scheduleRtspReconnect();
  }
}

/** A sink's MJPEG `<img>` failed to load. Unlike the WebRTC path there are no stats to poll on a
 *  multipart feed — the element's own `error` event is the ONLY signal that it died, or that this
 *  WebView can't render `multipart/x-mixed-replace` at all. Without this the feed just showed the
 *  WebView's broken-image placeholder while the app still claimed to be `live` (reported on Debian /
 *  WebKitGTK). RTSP re-enters the reconnect loop; native capture has no remote to retry, so it reports
 *  an error. Idempotent — every sink fires it, and the first one to arrive does the work. */
export function reportMjpegError(): void {
  const st = get(videoState);
  if (!st.enabled || !st.mjpegUrl) return;
  if (st.kind === 'rtsp') {
    logVideo('warn', `MJPEG image failed to load (${st.mjpegUrl}) — reconnecting`);
    scheduleRtspReconnect();
    return;
  }
  logVideo('warn', `MJPEG image failed to load (${st.mjpegUrl})`);
  patch({ status: 'error', mjpegUrl: null, error: get(t)('video.mjpegLoadFailed') });
}

/** Open a native capture device with device-verified resolution/framerate. Primary path: getUserMedia
 *  with `exact` constraints → a hardware-composited `<video>` MediaStream (no map-compositor
 *  contention, no transcoding — the same clean path as the plain camera). On Linux/WebKitGTK this is
 *  skipped in favour of the ffmpeg → MJPEG `<img>` server: the getUserMedia/GStreamer capture stack
 *  (pipewire/libcamera) hangs enumeration and software-decodes into a full-app freeze on weak hardware.
 *  The MJPEG server is also the fallback elsewhere for devices getUserMedia can't expose (e.g. some
 *  Linux HDMI dongles). */
export async function startNative(): Promise<void> {
  stopTracks();
  // Release a previous MJPEG capture FIRST. Its ffmpeg holds the device exclusively (DirectShow
  // always, V4L2 usually), so leaving it running made the getUserMedia attempt below fail with
  // NotReadableError — which fell back to MJPEG again, permanently. Changing resolution while on the
  // fallback path could therefore never return to the clean hardware <video> path.
  await stopNativeMjpeg();
  const st = get(videoState);
  const id = st.nativeDevice;
  if (!id) {
    patch({ kind: 'native', enabled: true, status: 'error', error: 'No capture device selected' });
    return;
  }
  patch({ kind: 'native', enabled: true, status: 'starting', error: null, rtspEngine: null, mjpegUrl: null });
  savePrefs();
  const sel = st.nativeSel;

  // Primary: hardware <video> via getUserMedia — EXCEPT on Linux/WebKitGTK, where that path drives
  // WebKit's GStreamer capture stack (pipewire/libcamera): it can hang enumeration ~35 s and
  // software-decodes every frame into a full-app freeze on weak hardware. There we go straight to the
  // ffmpeg→MJPEG server below (deterministic fps/res caps, no pipewire). getUserMedia stays primary on
  // Chromium/WebView2 (Windows) and WKWebView (macOS). Skipping it here also avoids the label-probe
  // (an extra getUserMedia) inside findGetUserMediaId, which a stalled pipewire could hang on.
  const guId = isLinux ? null : await findGetUserMediaId(id);
  if (guId) {
    try {
      const stream = await getNativeUserMedia(guId, sel);
      videoStream.set(stream);
      const s = stream.getVideoTracks()[0]?.getSettings();
      patch({
        status: 'live',
        error: null,
        rtspEngine: null,
        mjpegUrl: null,
        width: s?.width ?? sel.width,
        height: s?.height ?? sel.height,
        aspect: s?.width && s?.height ? s.width / s.height : sel.width / sel.height,
        frameRate: s?.frameRate ?? sel.fps,
      });
      return;
    } catch (e) {
      console.warn('[video] native getUserMedia failed, falling back to MJPEG', e);
      stopTracks();
    }
  }

  // Fallback: ffmpeg → MJPEG <img> (device not exposed by getUserMedia, or constraints unmet).
  try {
    const url = await startNativeMjpeg(sel, id);
    patch({
      status: 'live',
      mjpegUrl: url,
      error: null,
      rtspEngine: 'ffmpeg',
      width: sel.width,
      height: sel.height,
      aspect: sel.width / sel.height,
    });
  } catch (e) {
    patch({ status: 'error', error: e instanceof Error ? e.message : String(e), mjpegUrl: null });
  }
}

/** Start whichever source kind is currently selected. */
export function startActive(): Promise<void> {
  const kind = get(videoState).kind;
  if (kind === 'rtsp') return startRtsp();
  if (kind === 'native') return startNative();
  return startVideo();
}

/** Stop the source and release the camera / go2rtc engine. */
export function stopVideo(): void {
  const wasBackend = get(videoState).kind === 'rtsp' || get(videoState).kind === 'native';
  clearRtspTimers(); // end the RTSP reconnect loop on an explicit stop
  stopTracks();
  if (wasBackend) {
    void invoke('video_webrtc_stop').catch(() => {});
    void stopNativeMjpeg();
  }
  patch({ enabled: false, status: 'off', error: null, rtspEngine: null, mjpegUrl: null, reconnecting: false, reconnectAttempt: 0 });
  savePrefs();
}

export function toggleVideo(): void {
  if (get(videoState).enabled) stopVideo();
  else void startActive();
}

/** Switch source kind (camera ⇄ rtsp); restarts the new source if video was running. */
export async function setVideoKind(kind: VideoKind): Promise<void> {
  if (get(videoState).kind === kind) return;
  const wasEnabled = get(videoState).enabled;
  if (wasEnabled) stopVideo();
  patch({ kind, status: 'off', error: null });
  savePrefs();
  if (wasEnabled) await startActive();
}

export function setRtspUrl(rtspUrl: string): void {
  patch({ rtspUrl });
  savePrefs();
}

/** Set the active RTSP transport (udp/tcp/auto); restart if currently on a live RTSP feed. */
export async function setRtspTransport(transport: RtspTransport): Promise<void> {
  patch({ rtspTransport: transport });
  savePrefs();
  const st = get(videoState);
  if (st.enabled && st.kind === 'rtsp') await startRtsp();
}

function genRtspId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `rtsp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  }
}

/** Save the current URL + transport as a named entry in the connection list. Explicit action only —
 *  connections are NEVER auto-saved. Name defaults to the host (rename inline); dedupes by URL. */
export function saveRtspConnection(): void {
  const st = get(videoState);
  const url = st.rtspUrl.trim();
  if (!url) return;
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    /* keep the raw url as the name */
  }
  const list = st.rtspConnections.slice();
  const i = list.findIndex((c) => c.url === url);
  if (i >= 0) {
    list[i] = { ...list[i], transport: st.rtspTransport };
  } else {
    list.push({ id: genRtspId(), name: host, url, transport: st.rtspTransport });
  }
  patch({ rtspConnections: list });
  savePrefs();
}

/** Edit a saved connection (name / url / transport). */
export function updateRtspConnection(id: string, p: Partial<Omit<RtspConnection, 'id'>>): void {
  const list = get(videoState).rtspConnections.map((c) => (c.id === id ? { ...c, ...p } : c));
  patch({ rtspConnections: list });
  savePrefs();
}

/** Remove a saved connection. */
export function removeRtspConnection(id: string): void {
  const list = get(videoState).rtspConnections.filter((c) => c.id !== id);
  patch({ rtspConnections: list });
  savePrefs();
}

/** Load a saved connection into the active URL + transport and connect it. */
export async function selectRtspConnection(id: string): Promise<void> {
  const c = get(videoState).rtspConnections.find((x) => x.id === id);
  if (!c) return;
  if (get(videoState).kind !== 'rtsp' && get(videoState).enabled) stopVideo();
  patch({ kind: 'rtsp', rtspUrl: c.url, rtspTransport: c.transport });
  savePrefs();
  await startRtsp();
}

/** Switch native device: probe it, repair the selection, restart if live. The device *name* is stored
 *  alongside the id so an unstable id (AVFoundation index / `/dev/videoN`) can be re-resolved later. */
export async function setNativeDevice(id: string | null): Promise<void> {
  const name = id ? (get(videoState).nativeDevices.find((d) => d.id === id)?.name ?? null) : null;
  patch({ nativeDevice: id, nativeDeviceName: name });
  if (id) await probeNativeDevice(id);
  else patch({ nativeModes: [] });
  savePrefs();
  if (id && get(videoState).enabled && get(videoState).kind === 'native') await startNative();
}

/** Change native resolution; re-validate framerate; restart if live. */
export async function setNativeResolution(width: number, height: number): Promise<void> {
  const st = get(videoState);
  const sel = validateSelection(st.nativeModes, { ...st.nativeSel, width, height });
  patch({ nativeSel: sel });
  savePrefs();
  if (st.enabled && st.kind === 'native') await startNative();
}

/** Change native framerate; restart if live. */
export async function setNativeFramerate(fps: number): Promise<void> {
  const st = get(videoState);
  patch({ nativeSel: { ...st.nativeSel, fps } });
  savePrefs();
  if (st.enabled && st.kind === 'native') await startNative();
}

/** Change the getUserMedia framerate wish (camera path); restarts the stream if currently live. */
export async function setCameraFps(cameraFps: CameraFps): Promise<void> {
  patch({ cameraFps });
  savePrefs();
  if (get(videoState).enabled && get(videoState).kind === 'camera') await startVideo();
}

/** Switch device / resolution; restarts the stream if currently live. */
export async function setVideoDevice(deviceId: string | null): Promise<void> {
  patch({ deviceId });
  savePrefs();
  if (get(videoState).enabled) await startVideo();
}

export async function setVideoResolution(resolution: VideoResolution): Promise<void> {
  patch({ resolution });
  savePrefs();
  if (get(videoState).enabled) await startVideo();
}

export function setVideoMirror(mirror: boolean): void {
  patch({ mirror });
  savePrefs();
}

// ── Floating window ──────────────────────────────────────────────────
export function toggleFloating(): void {
  patch({ floating: !get(videoState).floating });
  savePrefs();
}

export function setFloatSnapped(floatSnapped: boolean): void {
  patch({ floatSnapped });
  savePrefs();
}

/** Free position (px). Snapping is decided by the caller (drag near corner). */
export function setFloatPos(floatX: number, floatY: number): void {
  patch({ floatX, floatY });
  savePrefs();
}

const FLOAT_MIN = 0.1;
const FLOAT_MAX = 0.3;
export function setFloatHeightFrac(frac: number): void {
  patch({ floatHeightFrac: Math.min(FLOAT_MAX, Math.max(FLOAT_MIN, frac)) });
  savePrefs();
}

// ── Map ⇄ video placement ────────────────────────────────────────────
/** Move the single map instance to a surface. Double-clicking a video calls this with that surface;
 *  the map jumps there and every other surface shows video. Fires a resize so Leaflet/Cesium re-fit
 *  to the new container size (the Map also has a ResizeObserver as a backstop). */
export function setMapLocation(loc: MapLocation): void {
  patch({ mapLocation: loc });
  if (typeof window !== 'undefined') {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  }
}

/** Publish the video widget's on-screen rect so the map can overlay it in `widget` mode. No-op when
 *  unchanged — callers fire it from ResizeObserver/resize handlers, and a redundant patch would churn
 *  the store (and could feed an effect loop). */
export function setWidgetRect(rect: { x: number; y: number; w: number; h: number } | null): void {
  const cur = get(videoState).widgetRect;
  if (cur === rect) return;
  if (
    cur &&
    rect &&
    cur.x === rect.x &&
    cur.y === rect.y &&
    cur.w === rect.w &&
    cur.h === rect.h
  ) {
    return;
  }
  patch({ widgetRect: rect });
}

// ── Native Picture-in-Picture ────────────────────────────────────────
// PiP is bound to its source <video> element, so the source must be a
// persistently-mounted element (not the panel preview, which unmounts when the
// panel closes — that would kill the PiP). The app root registers a hidden video
// element here; `enterPiP()` pops it out into a free-floating OS window that
// survives closing the panel.
export const pipSupported = typeof document !== 'undefined' && !!document.pictureInPictureEnabled;

let pipEl: HTMLVideoElement | null = null;
export function registerPiPElement(el: HTMLVideoElement | null): void {
  pipEl = el;
}

export async function enterPiP(): Promise<void> {
  const el = pipEl as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
  try {
    if (
      el?.requestPictureInPicture &&
      typeof document !== 'undefined' &&
      document.pictureInPictureEnabled &&
      document.pictureInPictureElement !== el
    ) {
      await el.requestPictureInPicture();
    }
  } catch (e) {
    console.warn('[video] Picture-in-Picture failed', e);
  }
}

/** Delay before auto-starting the Linux `camera` source, so the UI paints first (see `initVideo`). */
const LINUX_CAMERA_AUTOSTART_DELAY_MS = 1200;

/**
 * App-startup hook: enumerate devices and, if video was running at last close,
 * auto-start it with the persisted settings (device falls back to default if the
 * saved one is gone). Call once, client-side.
 */
export async function initVideo(): Promise<void> {
  // Skip getUserMedia enumeration at startup on Linux: it drives WebKit's GStreamer capture stack
  // (pipewire), which hangs ~35 s and freezes launch on boxes with an unreachable pipewire (the
  // symptom the native/MJPEG path was meant to avoid). Only the `camera` source needs this list, and
  // it's enumerated lazily when the panel shows the camera dropdown. Windows/macOS enumerate fast.
  if (mediaDevicesAvailable() && !isLinux) await enumerateVideoDevices();
  if (!boot.enabled) return;

  // Same stack, second entry point: on Linux the `camera` source's getUserMedia can stall the WebView
  // process just like the enumeration did, and auto-starting it inline would do that *before the app
  // has painted* — a blank window for half a minute. Skipping the enumeration alone didn't close that.
  // Deferring past first paint can't prevent a stall inside WebKit, but it does mean the user gets a
  // running, usable app either way. `native` and `rtsp` never touch that stack, so they start inline.
  if (isLinux && get(videoState).kind === 'camera') {
    setTimeout(() => void startActive(), LINUX_CAMERA_AUTOSTART_DELAY_MS);
    return;
  }
  await startActive();
}
