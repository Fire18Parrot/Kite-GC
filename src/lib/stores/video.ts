// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

// Embedded video — source router (v1: local webcam / USB capture; v2: RTSP via go2rtc;
// v3: V4L2 native capture for Linux HDMI dongles not exposed via getUserMedia).
//
// The router opens a source once and exposes its MediaStream; multiple sinks
// (the NavRail panel preview, the dock widget, the floating window, the
// map-swap view) bind the *same* stream to their own <video> element — a
// MediaStream attaches to many elements at once, so one decode feeds them all.
//
// `getUserMedia` works in both WebView2 (Windows) and WebKitGTK (Linux), so the
// webcam path needs no backend. Network streams (RTSP/UDP via a backend
// gstreamer pipeline) and OS-window detach are v2, layered on this same router.
// V4L2 capture devices go through go2rtc/ffmpeg → WebRTC (same pipeline as RTSP).

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

export interface VideoDevice {
  deviceId: string;
  label: string;
}

/** A V4L2 capture device discovered by the Rust backend (Linux). */
export interface V4l2Device {
  path: string;
  name: string;
  bus_info: string;
}

export type VideoStatus = 'off' | 'starting' | 'live' | 'error';
export type VideoResolution = 'auto' | '720p' | '1080p';
/** Source kind: local camera (MediaStream), RTSP bridge (go2rtc), or V4L2 native capture. */
export type VideoKind = 'camera' | 'rtsp' | 'v4l2';
/** Which go2rtc reader served the live RTSP feed: native client or the ffmpeg fallback. */
export type RtspEngine = 'native' | 'ffmpeg' | null;
/** Where the single map instance currently lives (the inverse of which surfaces show video). */
export type MapLocation = 'main' | 'floating' | 'widget';

export interface VideoState {
  /** Active source kind. `camera` → MediaStream/`srcObject`; `rtsp` → loopback `<video src>`; `v4l2` → go2rtc/ffmpeg→WebRTC. */
  kind: VideoKind;
  /** User wants video on (source open). */
  enabled: boolean;
  status: VideoStatus;
  devices: VideoDevice[];
  /** V4L2 capture devices (Linux) — enumerated by the Rust backend. */
  v4l2Devices: V4l2Device[];
  /** Selected V4L2 device path (e.g. "/dev/video0"), null if none. */
  v4l2Device: string | null;
  /** Selected video input device (null = system default). */
  deviceId: string | null;
  resolution: VideoResolution;
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
  rtspUrl: string;
  v4l2Device: string | null;
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
  rtspUrl: '',
  v4l2Device: null,
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
      const p = JSON.parse(raw) as Partial<VideoPrefs>;
      return {
        ...PREF_DEFAULTS,
        ...p,
        kind: p.kind ?? 'camera',
        deviceId: p.deviceId ?? null,
        resolution: p.resolution ?? 'auto',
        rtspUrl: p.rtspUrl ?? '',
        v4l2Device: p.v4l2Device ?? null,
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
        rtspUrl: s.rtspUrl,
        v4l2Device: s.v4l2Device,
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
  v4l2Devices: [],
  v4l2Device: boot.v4l2Device,
  deviceId: boot.deviceId,
  resolution: boot.resolution,
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

// Without a frameRate hint the browser may negotiate an uncompressed camera
// mode (YUY2/NV12) that is USB-bandwidth-limited to a few fps at high resolution.
// There is no way to request MJPEG directly, so we ask for a high rate (60, the
// FPV standard): only the camera's MJPEG mode can satisfy it, nudging the browser
// to pick it. (If the cam still won't deliver, the native backend source — v2 —
// is the real fix.)
const RES_CONSTRAINTS: Record<VideoResolution, MediaTrackConstraints> = {
  auto: { frameRate: { ideal: 60 } },
  '720p': { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
};

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

/** Start a V4L2 device via the built-in MJPEG server (no go2rtc dependency). */
async function startV4l2Mjpeg(device: string, width: number, height: number): Promise<string> {
  return await invoke<string>('video_v4l2_mjpeg_start', { device, width, height });
}

/** Stop the built-in MJPEG server. */
async function stopV4l2Mjpeg(): Promise<void> {
  await invoke('video_v4l2_mjpeg_stop').catch(() => {});
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

/** Enumerate V4L2 capture devices via the Rust backend (Linux only). */
export async function enumerateV4l2Devices(): Promise<void> {
  try {
    const devices = await invoke<V4l2Device[]>('video_list_v4l2');
    patch({ v4l2Devices: devices });
    // Auto-select the first device if none selected yet, or drop stale.
    const sel = get(videoState).v4l2Device;
    if (devices.length > 0) {
      if (!sel || !devices.some((d) => d.path === sel)) {
        patch({ v4l2Device: devices[0].path });
      }
    } else if (sel) {
      patch({ v4l2Device: null });
    }
  } catch (e) {
    // V4L2 not available on this platform — that's fine.
    patch({ v4l2Devices: [] });
  }
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
  const base: MediaTrackConstraints = { ...RES_CONSTRAINTS[st.resolution] };
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

/** Open a V4L2 capture device via the built-in MJPEG server.
 *  V4L2 is Linux-only, and WebKitGTK's WebRTC support is inconsistent across
 *  distros — the self-contained MJPEG path works reliably everywhere. */
export async function startV4l2(): Promise<void> {
  stopTracks();
  const st = get(videoState);
  const device = st.v4l2Device;
  if (!device) {
    patch({ kind: 'v4l2', enabled: true, status: 'error', error: 'No V4L2 device selected' });
    return;
  }
  patch({ kind: 'v4l2', enabled: true, status: 'starting', error: null, rtspEngine: null, mjpegUrl: null });
  savePrefs();

  const dims: Record<VideoResolution, [number, number]> = {
    auto: [1280, 720],
    '720p': [1280, 720],
    '1080p': [1920, 1080],
  };
  const [width, height] = dims[st.resolution];
  try {
    const url = await startV4l2Mjpeg(device, width, height);
    patch({ status: 'live', mjpegUrl: url, error: null, rtspEngine: 'ffmpeg', width, height });
  } catch (e) {
    patch({ status: 'error', error: e instanceof Error ? e.message : String(e), mjpegUrl: null });
  }
}

/** Start whichever source kind is currently selected. */
export function startActive(): Promise<void> {
  const kind = get(videoState).kind;
  if (kind === 'rtsp') return startRtsp();
  if (kind === 'v4l2') return startV4l2();
  return startVideo();
}

/** Stop the source and release the camera / go2rtc engine. */
export function stopVideo(): void {
  const wasBackend = get(videoState).kind === 'rtsp' || get(videoState).kind === 'v4l2';
  stopTracks();
  if (wasBackend) {
    void invoke('video_webrtc_stop').catch(() => {});
    void stopV4l2Mjpeg();
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

/** Switch V4L2 device; restarts the stream if currently live. */
export async function setV4l2Device(device: string | null): Promise<void> {
  patch({ v4l2Device: device });
  savePrefs();
  if (get(videoState).enabled && get(videoState).kind === 'v4l2') await startV4l2();
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
  if (mediaDevicesAvailable()) await enumerateVideoDevices();
  if (boot.enabled) await startActive();
}
