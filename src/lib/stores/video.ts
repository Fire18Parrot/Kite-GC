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
  /** Probed modes for the selected native device (drives the format→resolution→framerate cascade). */
  nativeModes: CaptureMode[];
  /** Chosen native capture config (format/resolution/framerate). */
  nativeSel: NativeSelection;
  // ── RTSP source ──────────────────────────────────────────────────
  /** RTSP URL (e.g. rtsp://192.168.1.10:554/live). */
  rtspUrl: string;
  /** Active RTSP reader once live (native go2rtc client vs ffmpeg fallback); runtime-only. */
  rtspEngine: RtspEngine;
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
  nativeDevice: string | null;
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
  nativeDevice: null,
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
        nativeDevice: p.nativeDevice ?? p.v4l2Device ?? null,
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
        nativeDevice: s.nativeDevice,
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
  nativeModes: [],
  nativeSel: {
    width: boot.nativeWidth,
    height: boot.nativeHeight,
    fps: boot.nativeFps,
  },
  rtspUrl: boot.rtspUrl,
  rtspEngine: null,
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

/** Enumerate native capture devices via the Rust backend (V4L2/DirectShow/AVFoundation). */
export async function enumerateNativeDevices(): Promise<void> {
  try {
    const devices = await invoke<NativeDevice[]>('video_list_native_devices');
    patch({ nativeDevices: devices });
    // Auto-select + probe the first device if none selected yet, else (re)probe the current one; drop
    // a stale selection.
    const sel = get(videoState).nativeDevice;
    if (devices.length > 0) {
      if (!sel || !devices.some((d) => d.id === sel)) {
        await setNativeDevice(devices[0].id);
      } else {
        await probeNativeDevice(sel);
      }
    } else if (sel) {
      patch({ nativeDevice: null, nativeModes: [] });
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
  await invoke('video_webrtc_start', { url, useFfmpeg });

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
    if (rtcConn === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
      patch({ status: 'error', error: `WebRTC ${pc.connectionState}` });
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

/** Open (or re-open) the RTSP feed via go2rtc. Uses WebRTC when available,
 *  falls back to MJPEG over HTTP when RTCPeerConnection is missing. */
export async function startRtsp(): Promise<void> {
  stopTracks(); // release the camera / previous peer connection
  const st = get(videoState);
  const url = st.rtspUrl.trim();
  if (!url) {
    patch({ kind: 'rtsp', enabled: true, status: 'error', error: 'No RTSP URL' });
    return;
  }
  patch({ kind: 'rtsp', enabled: true, status: 'starting', error: null, rtspEngine: null, mjpegUrl: null });
  savePrefs();

  // MJPEG fallback: register the source (go2rtc handles RTSP natively) and use its HTTP endpoint.
  if (!isWebrtcAvailable()) {
    try {
      // Start the stream with go2rtc's native client (no WebRTC needed)
      await invoke('video_webrtc_start', { url, useFfmpeg: false });
      const mjpegUrl = await buildMjpegUrl();
      patch({ status: 'live', mjpegUrl, error: null, rtspEngine: 'native' });
    } catch (e) {
      closeRtc();
      patch({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  try {
    await negotiateWebrtc(url, false); // native go2rtc RTSP client
  } catch (nativeErr) {
    console.warn('[video] native go2rtc RTSP failed, retrying via ffmpeg', nativeErr);
    closeRtc();
    if (get(videoState).status === 'off') return; // stopped meanwhile
    try {
      await negotiateWebrtc(url, true); // ffmpeg reader fallback
    } catch (ffmpegErr) {
      closeRtc();
      patch({ status: 'error', error: ffmpegErr instanceof Error ? ffmpegErr.message : String(ffmpegErr) });
    }
  }
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
  stopTracks();
  if (wasBackend) {
    void invoke('video_webrtc_stop').catch(() => {});
    void stopNativeMjpeg();
  }
  patch({ enabled: false, status: 'off', error: null, rtspEngine: null, mjpegUrl: null });
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

/** Switch native device: probe it, repair the selection, restart if live. */
export async function setNativeDevice(id: string | null): Promise<void> {
  patch({ nativeDevice: id });
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
  if (boot.enabled) await startActive();
}
