// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Video commands — the go2rtc RTSP→WebRTC engine + its ffmpeg fallback dependency.
//! See docs/active/RTSP_VIDEO.md.
//!
//! **Threading:** every command here that spawns a helper process, waits on one, or tears one down is
//! marked `#[tauri::command(async)]`. Tauri runs plain `fn` commands on the **main thread**, so a
//! device enumeration behind a wedged capture driver (or a `--version` call on a binary Gatekeeper /
//! Defender is still scanning) would freeze the whole UI. Only trivially-cheap commands stay sync.

use tauri::{AppHandle, Emitter, State};

use crate::video::{ffmpeg, go2rtc, native, Go2Rtc};

/// Fixed go2rtc stream name for the single live feed.
const STREAM_NAME: &str = "kite";

/// ffmpeg version string (`ffmpeg -version` first line), or null if it isn't installed yet. ffmpeg is
/// the fallback RTSP reader for go2rtc (sources its native client can't read), not always required.
#[tauri::command(async)]
pub fn video_ffmpeg_status() -> Option<String> {
    ffmpeg::version()
}

/// Download ffmpeg into the app-data `bin/` dir (Windows). Emits `ffmpeg-download-progress`
/// (`{ pct, msg }`). Returns the installed path. go2rtc is pointed at this path, so a freshly
/// downloaded ffmpeg is picked up on the next stream start without restarting go2rtc.
#[tauri::command]
pub async fn video_ffmpeg_download(app_handle: AppHandle) -> Result<String, String> {
    let report = |pct: u8, msg: &str| {
        let _ = app_handle.emit(
            "ffmpeg-download-progress",
            serde_json::json!({ "pct": pct, "msg": msg }),
        );
    };
    let path = ffmpeg::download(report).await?;
    Ok(path.to_string_lossy().to_string())
}

// ── go2rtc / WebRTC (the live RTSP path) ─────────────────────────────

/// go2rtc presence string (version/installed), or null if not installed yet.
#[tauri::command(async)]
pub fn video_go2rtc_status() -> Option<String> {
    go2rtc::status()
}

/// Download go2rtc into the app-data `bin/` dir (Windows). Emits `go2rtc-download-progress`
/// (`{ pct, msg }`). Returns the installed path.
#[tauri::command]
pub async fn video_go2rtc_download(app_handle: AppHandle) -> Result<String, String> {
    let report = |pct: u8, msg: &str| {
        let _ = app_handle.emit(
            "go2rtc-download-progress",
            serde_json::json!({ "pct": pct, "msg": msg }),
        );
    };
    let path = go2rtc::download(report).await?;
    Ok(path.to_string_lossy().to_string())
}

/// Start (or refresh) the go2rtc RTSP→WebRTC stream for `url`. Ensures go2rtc is running and
/// registers the source. The browser then negotiates WebRTC via `video_webrtc_offer`.
///
/// `mjpeg`: the feed will be consumed as MJPEG over HTTP (the fallback for WebViews without WebRTC),
/// which forces an ffmpeg transcode — see below.
///
/// `use_ffmpeg`: register the source via go2rtc's bundled-ffmpeg reader instead of its native RTSP
/// client. The `input=rtsp/udp` template uses ffmpeg WITHOUT a forced `-rtsp_transport`, which is the
/// only mode that reads quirky servers (e.g. obs-rtspserver, which 461s any forced transport). Used
/// as the automatic fallback when the native client fails.
///
#[tauri::command]
pub async fn video_webrtc_start(
    url: String,
    use_ffmpeg: bool,
    mjpeg: bool,
    engine: State<'_, Go2Rtc>,
) -> Result<(), String> {
    let port = engine.ensure_running()?;
    // `mjpeg` = the consumer will be go2rtc's `/api/stream.mjpeg` endpoint, which can only serve a
    // stream that actually carries an MJPEG track. An ordinary H.264 camera does not, so the source
    // must be registered with `#video=mjpeg` — an ffmpeg TRANSCODE, not a copy. Without it the endpoint
    // fails the moment the <img> requests it, which is exactly how the MJPEG fallback died on the Pi.
    // The MJPEG path is committed to the ffmpeg reader either way, so it always takes the permissive
    // `input=rtsp/udp` template (ffmpeg with NO forced -rtsp_transport) rather than honouring the
    // transport choice: that is the only variant that also reads UDP-only servers, and a connection
    // left on "Auto" would otherwise fail to open one at all.
    let src = if mjpeg {
        format!("ffmpeg:{url}#input=rtsp/udp#video=mjpeg")
    } else if use_ffmpeg {
        format!("ffmpeg:{url}#input=rtsp/udp#video=copy")
    } else {
        url.clone()
    };
    // Bounded: never let a wedged go2rtc freeze the frontend's reconnect loop.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .put(format!("http://127.0.0.1:{port}/api/streams"))
        .query(&[("name", STREAM_NAME), ("src", src.as_str())])
        .send()
        .await
        .map_err(|e| format!("go2rtc add-stream failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("go2rtc add-stream HTTP {}", resp.status()));
    }
    Ok(())
}

/// Exchange a browser WebRTC SDP offer with go2rtc and return the SDP answer (proxied to avoid CORS).
#[tauri::command]
pub async fn video_webrtc_offer(sdp: String, engine: State<'_, Go2Rtc>) -> Result<String, String> {
    let port = engine
        .port()
        .ok_or("go2rtc is not running — start the stream first")?;
    // Bounded: go2rtc blocks this answer until the producer probes the source — on a wedged/dead
    // RTSP server that wait is unbounded and froze the frontend's reconnect loop. 15 s is enough
    // for any healthy source (probe is normally <2 s).
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}/api/webrtc"))
        .query(&[("src", STREAM_NAME)])
        .json(&serde_json::json!({ "type": "offer", "sdp": sdp }))
        .send()
        .await
        .map_err(|e| format!("go2rtc WebRTC offer failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Surface go2rtc's own error text (e.g. RTSP connect failure / codec mismatch).
        return Err(format!("go2rtc WebRTC offer HTTP {status}: {}", body.trim()));
    }
    let answer: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("go2rtc answer parse failed: {e} (body: {body})"))?;
    answer
        .get("sdp")
        .and_then(serde_json::Value::as_str)
        .map(|s| s.to_string())
        .ok_or("go2rtc answer has no SDP".to_string())
}

/// Stop the WebRTC stream (kills the local go2rtc process). Idempotent. Async: the graceful teardown
/// does a blocking DELETE + a settle delay before the kill (~1 s worst case).
#[tauri::command(async)]
pub fn video_webrtc_stop(engine: State<'_, Go2Rtc>) -> Result<(), String> {
    engine.stop();
    Ok(())
}

/// Return the go2rtc API port if the engine is running, or null.
/// Used by the frontend to construct HTTP fallback URLs (MJPEG, etc.)
/// when RTCPeerConnection is unavailable.
#[tauri::command]
pub fn video_go2rtc_port(engine: State<'_, Go2Rtc>) -> Option<u16> {
    engine.port()
}

// ── Native capture (V4L2 / DirectShow / AVFoundation) ─────────────────

/// Enumerate native capture devices (USB/HDMI dongles etc.) for the "Advanced" source. Uses the OS
/// hardware layer via ffmpeg (Linux V4L2, Windows DirectShow, macOS AVFoundation). Empty on
/// unsupported platforms / when ffmpeg is missing.
#[tauri::command(async)]
pub fn video_list_native_devices() -> Vec<native::NativeDevice> {
    native::list_devices()
}

/// Probe a device's supported capture modes (codec + resolution range + fps range). Best-effort: V4L2
/// reports no framerate (0 = unknown) and AVFoundation returns nothing — the frontend then falls back
/// to the curated FPV catalog.
#[tauri::command(async)]
pub fn video_probe_device(id: String) -> Vec<native::CaptureMode> {
    native::probe(&id)
}

/// Start the embedded MJPEG HTTP server capturing from a native device with the chosen mode
/// (codec/resolution/framerate). MJPEG input is stream-copied; anything else is transcoded. Returns
/// the local URL (`http://127.0.0.1:PORT/`), killing any previous server first.
///
/// Only returns `Ok` once the capture actually produced its first bytes — a device that rejects the
/// requested mode used to leave the UI showing "live" over a black frame (see `MjpegServer::start`).
#[tauri::command(async)]
pub fn video_native_mjpeg_start(
    id: String,
    codec: String,
    width: u32,
    height: u32,
    fps: u32,
    mjpeg: State<'_, crate::video::MjpegServer>,
) -> Result<String, String> {
    let spec = native::CaptureSpec { id, codec, width, height, fps };
    let port = mjpeg.start(&spec)?;
    Ok(format!("http://127.0.0.1:{port}/"))
}

/// Stop the embedded MJPEG server if running. Async: kills ffmpeg and joins the broadcast threads,
/// which can sit in a blocking client write for up to `CLIENT_WRITE_TIMEOUT`.
#[tauri::command(async)]
pub fn video_native_mjpeg_stop(mjpeg: State<'_, crate::video::MjpegServer>) -> Result<(), String> {
    mjpeg.stop();
    Ok(())
}
