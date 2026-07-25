// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Native capture — the OS hardware layer behind the "Advanced" video source.
//!
//! One pipeline, three demuxers: Linux **V4L2**, Windows **DirectShow**, macOS **AVFoundation** — all
//! driven through the bundled ffmpeg (`video/ffmpeg.rs`) into the embedded MJPEG server
//! (`video/mjpeg_server.rs`). This module does three things:
//!   1. `list_devices()` — enumerate capture devices per OS.
//!   2. `probe(id)`      — query a device's supported modes (codec + resolution range + fps range).
//!   3. `input_args(spec)` / `needs_transcode()` — build the ffmpeg input for a chosen mode.
//!
//! The frontend intersects `probe()` output with a curated FPV catalog (see
//! `helpers/videoCapabilities.ts`) so the picker stays short. Probe data is best-effort: V4L2's
//! `-list_formats` has no framerate (fps reported as 0 = unknown → the UI offers curated defaults),
//! and AVFoundation listings are too terse to parse reliably (probe returns empty → full catalog).

use serde::Serialize;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Hard cap on a device-enumeration / probe call. ffmpeg normally answers in well under a second;
/// a wedged capture driver (DirectShow and AVFoundation both do this) can block **forever**, and this
/// used to be an unbounded `Command::output()`. Bounded + killed, so a bad device costs one slow
/// dropdown instead of a stuck helper process.
const QUERY_TIMEOUT: Duration = Duration::from_secs(8);

/// A discovered native capture device. `id` is what ffmpeg addresses the device by on this OS:
/// V4L2 = `/dev/videoN`, DirectShow = the friendly name, AVFoundation = the numeric index.
#[derive(Debug, Clone, Serialize)]
pub struct NativeDevice {
    pub id: String,
    pub name: String,
}

/// One supported capture mode. Resolutions are a range (`min`..`max`) because DirectShow reports
/// ranges; discrete devices report `min == max`. `fps_max <= 0` means "unknown" (V4L2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMode {
    /// Normalized codec/pixel-format token: `mjpeg` | `yuyv` | `nv12` | `h264` | `hevc` | raw fourcc.
    pub codec: String,
    pub min_width: u32,
    pub min_height: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub fps_min: f32,
    pub fps_max: f32,
}

/// A chosen capture configuration, handed to the MJPEG server to build the ffmpeg command.
pub struct CaptureSpec {
    pub id: String,
    /// Input codec token (see `CaptureMode::codec`), or `auto` to let ffmpeg/the OS pick.
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

// ── Enumeration + probe (per-OS dispatch) ─────────────────────────────

/// Enumerate native capture devices for the current OS. Empty on unsupported platforms.
pub fn list_devices() -> Vec<NativeDevice> {
    #[cfg(target_os = "linux")]
    {
        crate::video::v4l2::enumerate()
            .into_iter()
            .map(|d| NativeDevice { id: d.path, name: d.name })
            .collect()
    }
    #[cfg(target_os = "windows")]
    {
        run_ffmpeg_stderr(&["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"])
            .map(|s| parse_dshow_devices(&s))
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        run_ffmpeg_stderr(&["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
            .map(|s| parse_avf_devices(&s))
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// Probe a device's supported capture modes. Best-effort (see module docs); an empty result makes the
/// frontend fall back to the full curated catalog with unknown-fps handling.
pub fn probe(id: &str) -> Vec<CaptureMode> {
    #[cfg(target_os = "linux")]
    {
        run_ffmpeg_stderr(&["-hide_banner", "-f", "v4l2", "-list_formats", "all", "-i", id])
            .map(|s| parse_v4l2_modes(&s))
            .unwrap_or_default()
    }
    #[cfg(target_os = "windows")]
    {
        let (dev_name, dev_num) = dshow_split_id(id);
        let arg = format!("video={dev_name}");
        let num = dev_num.map(|n| n.to_string());
        let mut args: Vec<&str> = vec!["-hide_banner", "-f", "dshow", "-list_options", "true"];
        if let Some(n) = num.as_deref() {
            args.push("-video_device_number");
            args.push(n);
        }
        args.push("-i");
        args.push(&arg);
        run_ffmpeg_stderr(&args)
            .map(|s| parse_dshow_modes(&s))
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        // AVFoundation (macOS) + others: no reliable listing → curated-catalog fallback in the UI.
        let _ = id;
        Vec::new()
    }
}

// ── ffmpeg input construction ─────────────────────────────────────────

/// Build the ffmpeg *input* args (everything up to and including `-i <device>`) for the current OS.
pub fn input_args(spec: &CaptureSpec) -> Vec<String> {
    let size = format!("{}x{}", spec.width, spec.height);
    let fps = spec.fps.to_string();
    #[cfg(target_os = "linux")]
    {
        let mut a = vec!["-f".into(), "v4l2".into()];
        if spec.codec != "auto" {
            a.push("-input_format".into());
            a.push(v4l2_input_format(&spec.codec));
        }
        a.push("-framerate".into());
        a.push(fps);
        a.push("-video_size".into());
        a.push(size);
        a.push("-i".into());
        a.push(spec.id.clone());
        a
    }
    #[cfg(target_os = "windows")]
    {
        let (dev_name, dev_num) = dshow_split_id(&spec.id);
        let mut a = vec!["-f".into(), "dshow".into()];
        if let Some(n) = dev_num {
            // Disambiguate identical friendly names (see `parse_dshow_devices`). Input option → before -i.
            a.push("-video_device_number".into());
            a.push(n.to_string());
        }
        a.push("-framerate".into());
        a.push(fps);
        a.push("-video_size".into());
        a.push(size);
        match spec.codec.as_str() {
            "auto" => {}
            "mjpeg" => {
                a.push("-vcodec".into());
                a.push("mjpeg".into());
            }
            "h264" => {
                a.push("-vcodec".into());
                a.push("h264".into());
            }
            other => {
                a.push("-pixel_format".into());
                a.push(dshow_pixfmt(other));
            }
        }
        a.push("-i".into());
        a.push(format!("video={dev_name}"));
        a
    }
    #[cfg(target_os = "macos")]
    {
        // AVFoundation negotiates the pixel format itself; forcing one is unreliable, so we only pin
        // size + framerate and let it pick (the output stage always transcodes to MJPEG anyway).
        let mut a = vec!["-f".into(), "avfoundation".into()];
        a.push("-framerate".into());
        a.push(fps);
        a.push("-video_size".into());
        a.push(size);
        a.push("-i".into());
        a.push(spec.id.clone());
        a
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = (&spec.id, &spec.codec, size, fps);
        Vec::new()
    }
}

/// Whether the input codec must be transcoded to MJPEG for the `mpjpeg` multipart sink. Only a genuine
/// MJPEG input can be stream-copied; everything else (raw YUYV/NV12, H.264, or `auto`) is re-encoded.
pub fn needs_transcode(codec: &str) -> bool {
    codec != "mjpeg"
}

// ── ffmpeg invocation ─────────────────────────────────────────────────

/// Run ffmpeg with the given args and return its **stderr** (ffmpeg prints device/format listings and
/// diagnostics there). Returns None if ffmpeg isn't installed, couldn't be launched, or didn't finish
/// within `QUERY_TIMEOUT` — in which case the child is killed rather than left behind.
///
/// The read happens on a helper thread so the wait can be bounded (`std::process` has no
/// wait-with-timeout): stderr reaches EOF when ffmpeg exits, so a value on the channel means "done".
fn run_ffmpeg_stderr(args: &[&str]) -> Option<String> {
    let bin = super::ffmpeg::find_ffmpeg()?;
    let mut cmd = Command::new(&bin);
    crate::child_env::sanitize(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null()) // listings go to stderr; discard stdout so it can't fill a pipe
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — don't flash a console
    }
    let mut child = cmd.spawn().ok()?;
    let mut stderr = child.stderr.take()?;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read as _;
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });

    match rx.recv_timeout(QUERY_TIMEOUT) {
        Ok(text) => {
            let _ = child.wait();
            Some(text)
        }
        Err(_) => {
            log::warn!(
                "[video] ffmpeg device query timed out after {}s — killing it (args: {:?})",
                QUERY_TIMEOUT.as_secs(),
                args
            );
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

// ── Parsers (pure; unit-tested cross-platform) ────────────────────────

/// Parse `ffmpeg -f dshow -list_devices true` stderr into video devices (audio devices skipped).
///
/// DirectShow addresses a device by its friendly name, so two identical capture cards are literally
/// indistinguishable — both listed as e.g. "USB Video", and `-i video=USB Video` always opens the
/// first. ffmpeg's way out is `-video_device_number N` (0-based, "for devices with the same name"), so
/// the 2nd, 3rd … occurrence gets its id tagged `<name>#N` (decoded again by `dshow_split_id`) and its
/// label numbered, which also stops the dropdown from showing two identical rows.
#[allow(dead_code)]
fn parse_dshow_devices(stderr: &str) -> Vec<NativeDevice> {
    let mut out: Vec<NativeDevice> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut in_video = false;
    for line in stderr.lines() {
        if line.contains("DirectShow video devices") {
            in_video = true;
            continue;
        }
        if line.contains("DirectShow audio devices") {
            in_video = false;
            continue;
        }
        if line.contains("Alternative name") {
            continue;
        }
        if let Some(name) = first_quoted(line) {
            // Newer ffmpeg tags the type inline; otherwise fall back to the section we're in.
            let is_video = if line.contains("(video)") {
                true
            } else if line.contains("(audio)") {
                false
            } else {
                in_video
            };
            if is_video && !name.is_empty() {
                let n = seen.iter().filter(|s| **s == name).count();
                seen.push(name.clone());
                if n == 0 {
                    out.push(NativeDevice { id: name.clone(), name });
                } else {
                    out.push(NativeDevice {
                        id: format!("{name}#{n}"),
                        name: format!("{name} ({})", n + 1),
                    });
                }
            }
        }
    }
    out
}

/// Parse `ffmpeg -f avfoundation -list_devices true` stderr into video devices (id = index).
#[allow(dead_code)]
fn parse_avf_devices(stderr: &str) -> Vec<NativeDevice> {
    let mut out = Vec::new();
    let mut in_video = false;
    for line in stderr.lines() {
        if line.contains("AVFoundation video devices") {
            in_video = true;
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            in_video = false;
            continue;
        }
        if !in_video {
            continue;
        }
        if let Some((idx, name)) = avf_index_line(line) {
            // AVFoundation lists "Capture screen N" (screen grab) among the video devices — not a
            // real camera, so keep it out of the capture picker.
            if name.to_ascii_lowercase().starts_with("capture screen") {
                continue;
            }
            out.push(NativeDevice { id: idx, name });
        }
    }
    out
}

/// Parse a V4L2 `-list_formats all` stderr into modes (one per codec×resolution; fps unknown = 0).
#[allow(dead_code)]
fn parse_v4l2_modes(stderr: &str) -> Vec<CaptureMode> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        if !(line.contains("Raw") || line.contains("Compressed")) {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let after = line[colon + 1..].trim_start();
        let Some(codec_tok) = after.split_whitespace().next() else { continue };
        let codec = normalize_codec(codec_tok);
        for tok in line.split_whitespace() {
            if let Some((w, h)) = parse_wxh(tok) {
                out.push(CaptureMode {
                    codec: codec.clone(),
                    min_width: w,
                    min_height: h,
                    max_width: w,
                    max_height: h,
                    fps_min: 0.0,
                    fps_max: 0.0,
                });
            }
        }
    }
    out
}

/// Parse a DirectShow `-list_options true` stderr into modes (codec + WxH range + fps range).
#[allow(dead_code)]
fn parse_dshow_modes(stderr: &str) -> Vec<CaptureMode> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        if !line.contains("min s=") || !line.contains("max s=") {
            continue;
        }
        let codec = if let Some(v) = field_after(line, "vcodec=") {
            normalize_codec(&v)
        } else if let Some(v) = field_after(line, "pixel_format=") {
            normalize_codec(&v)
        } else {
            continue;
        };
        let Some((min_w, min_h)) = field_after(line, "min s=").and_then(|s| parse_wxh(&s)) else {
            continue;
        };
        let Some((max_w, max_h)) = field_after(line, "max s=").and_then(|s| parse_wxh(&s)) else {
            continue;
        };
        // Two `fps=` values (after min s / after max s); take the overall min/max defensively.
        let fps: Vec<f32> = all_fields_after(line, "fps=")
            .iter()
            .filter_map(|s| s.parse::<f32>().ok())
            .collect();
        let fps_min = fps.iter().cloned().fold(f32::INFINITY, f32::min);
        let fps_max = fps.iter().cloned().fold(0.0_f32, f32::max);
        out.push(CaptureMode {
            codec,
            min_width: min_w,
            min_height: min_h,
            max_width: max_w,
            max_height: max_h,
            fps_min: if fps_min.is_finite() { fps_min } else { 0.0 },
            fps_max,
        });
    }
    out
}

// ── small text helpers ────────────────────────────────────────────────

/// First `"..."`-quoted substring on a line, if any.
#[allow(dead_code)]
fn first_quoted(line: &str) -> Option<String> {
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

/// From an AVFoundation `[...] [N] Name` line, extract `(index, name)` using the LAST `[digits]` group
/// (the log prefix also uses brackets, so the device index is the last bracketed number).
#[allow(dead_code)]
fn avf_index_line(line: &str) -> Option<(String, String)> {
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0;
    while let Some(rel) = line[i..].find('[') {
        let open = i + rel;
        let Some(rel2) = line[open + 1..].find(']') else { break };
        let close = open + 1 + rel2;
        let inner = &line[open + 1..close];
        if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
            best = Some((open, close));
        }
        i = close + 1;
    }
    let (open, close) = best?;
    let idx = line[open + 1..close].to_string();
    let name = line[close + 1..].trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some((idx, name))
}

/// Parse a `WxH` token (e.g. `1280x720`) into `(w, h)`; rejects non-numeric / zero / absurd sizes so it
/// never trips over hex log addresses like `0x55ab`.
fn parse_wxh(tok: &str) -> Option<(u32, u32)> {
    let (w, h) = tok.split_once('x')?;
    let w: u32 = w.parse().ok()?;
    let h: u32 = h.parse().ok()?;
    if w == 0 || h == 0 || w > 8192 || h > 8192 {
        return None;
    }
    Some((w, h))
}

/// Value token immediately following `key` (whitespace-delimited).
#[allow(dead_code)]
fn field_after(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let rest = line[start..].trim_start();
    rest.split_whitespace().next().map(|s| s.to_string())
}

/// All value tokens following each occurrence of `key`.
#[allow(dead_code)]
fn all_fields_after(line: &str, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = line[from..].find(key) {
        let start = from + rel + key.len();
        if let Some(tok) = line[start..].trim_start().split_whitespace().next() {
            out.push(tok.to_string());
        }
        from = start;
    }
    out
}

/// Normalize a codec / pixel-format token to a stable lowercase key the frontend maps to a label.
fn normalize_codec(tok: &str) -> String {
    let t = tok.trim().to_ascii_lowercase();
    if t.starts_with("mjpg") || t.starts_with("mjpeg") {
        "mjpeg".into()
    } else if t.starts_with("yuyv") || t == "yuy2" {
        "yuyv".into()
    } else if t.starts_with("h264") || t == "avc1" {
        "h264".into()
    } else if t.starts_with("hevc") || t.starts_with("h265") {
        "hevc".into()
    } else if t.starts_with("nv12") {
        "nv12".into()
    } else {
        t
    }
}

/// Map our normalized codec back to the V4L2 `-input_format` token.
#[allow(dead_code)]
fn v4l2_input_format(codec: &str) -> String {
    match codec {
        "yuyv" => "yuyv422".into(),
        other => other.into(),
    }
}

/// Split a DirectShow device id back into `(friendly name, device number)` — the inverse of the
/// duplicate tagging in `parse_dshow_devices`. Untagged ids (the common case, and every id persisted
/// before the tagging existed) come back unchanged with no number.
#[allow(dead_code)]
fn dshow_split_id(id: &str) -> (String, Option<u32>) {
    if let Some((base, idx)) = id.rsplit_once('#') {
        // Only a non-empty base + a pure number is a tag; a device genuinely named "…#3" is unheard of,
        // and the tag is only ever emitted for a repeated name in the first place.
        if !base.is_empty() {
            if let Ok(n) = idx.parse::<u32>() {
                return (base.to_string(), Some(n));
            }
        }
    }
    (id.to_string(), None)
}

/// Map our normalized codec back to a DirectShow `-pixel_format` token.
#[allow(dead_code)]
fn dshow_pixfmt(codec: &str) -> String {
    match codec {
        "yuyv" => "yuyv422".into(),
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dshow_devices() {
        let s = "\
[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0x1]  \"Integrated Camera\"
[dshow @ 0x1]     Alternative name \"@device_pnp_\\\\?\\usb#vid\"
[dshow @ 0x1]  \"USB Video\"
[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1]  \"Microphone (Realtek)\"";
        let d = parse_dshow_devices(s);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].name, "Integrated Camera");
        assert_eq!(d[1].id, "USB Video");
    }

    #[test]
    fn dshow_duplicate_names_get_a_device_number() {
        let s = "\
[dshow @ 0x1] DirectShow video devices
[dshow @ 0x1]  \"USB Video\"
[dshow @ 0x1]  \"USB Video\"
[dshow @ 0x1]  \"Integrated Camera\"";
        let d = parse_dshow_devices(s);
        assert_eq!(d.len(), 3);
        // First keeps the bare name (so ids persisted before the tagging still resolve).
        assert_eq!((d[0].id.as_str(), d[0].name.as_str()), ("USB Video", "USB Video"));
        assert_eq!((d[1].id.as_str(), d[1].name.as_str()), ("USB Video#1", "USB Video (2)"));
        assert_eq!(d[2].id, "Integrated Camera");
    }

    #[test]
    fn dshow_id_split() {
        assert_eq!(dshow_split_id("USB Video"), ("USB Video".to_string(), None));
        assert_eq!(dshow_split_id("USB Video#1"), ("USB Video".to_string(), Some(1)));
        // Not a tag: no number after the separator.
        assert_eq!(dshow_split_id("Cam #A"), ("Cam #A".to_string(), None));
    }

    #[test]
    fn dshow_modes() {
        let s = "\
[dshow @ 0x1]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1920x1080 fps=30
[dshow @ 0x1]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30";
        let m = parse_dshow_modes(s);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].codec, "mjpeg");
        assert_eq!((m[0].min_width, m[0].max_width), (1280, 1920));
        assert_eq!((m[0].fps_min, m[0].fps_max), (5.0, 30.0));
        assert_eq!(m[1].codec, "yuyv");
        assert_eq!((m[1].max_width, m[1].max_height), (640, 480));
    }

    #[test]
    fn v4l2_modes_no_fps() {
        let s = "\
[video4linux2,v4l2 @ 0x556] Raw       :     yuyv422 :           YUYV 4:2:2 : 640x480 1280x720
[video4linux2,v4l2 @ 0x556] Compressed:        mjpeg :          Motion-JPEG : 640x480 1920x1080";
        let m = parse_v4l2_modes(s);
        // 2 yuyv + 2 mjpeg resolutions; the 0x556 log address must NOT become a resolution.
        assert_eq!(m.len(), 4);
        assert!(m.iter().all(|x| x.fps_max == 0.0));
        assert!(m.iter().any(|x| x.codec == "mjpeg" && x.max_width == 1920));
        assert!(m.iter().any(|x| x.codec == "yuyv" && x.max_width == 1280));
    }

    #[test]
    fn avf_devices() {
        let s = "\
[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f] [1] USB Capture HDMI
[AVFoundation indev @ 0x7f] [2] Capture screen 0
[AVFoundation indev @ 0x7f] AVFoundation audio devices:
[AVFoundation indev @ 0x7f] [0] Built-in Microphone";
        let d = parse_avf_devices(s);
        // Two real cameras kept; the screen-capture pseudo-device dropped. "USB Capture HDMI" (a
        // capture card, not a screen grab) must survive.
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].id, "0");
        assert_eq!(d[1].name, "USB Capture HDMI");
    }

    #[test]
    fn wxh_guards() {
        assert_eq!(parse_wxh("1920x1080"), Some((1920, 1080)));
        assert_eq!(parse_wxh("0x556ab"), None);
        assert_eq!(parse_wxh("nonsense"), None);
    }
}
