// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Embedded MJPEG-over-HTTP server. Serves two kinds of source:
//!
//! * **native capture devices** (V4L2 / DirectShow / AVFoundation) — the per-OS input + codec
//!   handling lives in `video/native.rs`.
//! * **RTSP streams whose picture reaches the screen as MJPEG** — either because the source already
//!   sends MJPEG, or because this WebView has no WebRTC and the H.264 has to be transcoded.
//!
//! Spawns `ffmpeg … -f mpjpeg -` and **broadcasts** its stdout to every connected HTTP client as a
//! `multipart/x-mixed-replace` stream on a local port. One ffmpeg decode/transcode fans out to all
//! sinks (panel preview, floating window, dock widget, full-screen swap).
//!
//! Sockets get `TCP_NODELAY` and ffmpeg flushes per packet, so localhost delivery isn't bunched by
//! Nagle/output buffering (which shows up as sporadic stutter, worse at 60 fps).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Drop a client that can't accept data within this window — prevents one stalled `<img>` (e.g. an
/// occluded/throttled view) from blocking the shared broadcast (and back-pressuring ffmpeg).
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// How long `start()` waits for the capture's first bytes before declaring it failed. Generous enough
/// for an HDMI dongle negotiating a mode (1–2 s is normal), short enough that a rejected mode reports
/// back while the user is still looking at "Starting…".
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(6);

/// The multipart HTTP response preamble sent once per client before the frame stream.
/// `Access-Control-Allow-Origin` is required because the WebView reads this stream with `fetch` from
/// a worker (the off-thread MJPEG reader) — a cross-origin fetch without it is blocked. An `<img>`,
/// which is what the fallback path still uses, never needed the header.
const HTTP_HEADERS: &[u8] = b"HTTP/1.1 200 OK\r\n\
    Content-Type: multipart/x-mixed-replace; boundary=ffmpeg\r\n\
    Access-Control-Allow-Origin: *\r\n\
    Cache-Control: no-cache\r\n\
    Connection: close\r\n\
    \r\n";

/// What the server captures from.
pub enum MjpegSource<'a> {
    /// A local capture device, described by the mode the user picked.
    Device(&'a super::native::CaptureSpec),
    /// A network stream, read directly rather than through go2rtc.
    ///
    /// go2rtc drives an `ffmpeg:` source by having ffmpeg publish **back into go2rtc** over RTSP/TCP,
    /// so a stream that is already MJPEG gets packetised into RTP/JPEG (RFC 2435), reassembled and
    /// repacked as HTTP multipart. Measured over the same 120 s against a UAV-Link: the source had
    /// **zero** arrival gaps above 200 ms, go2rtc's output had **69**, each of them ~338 ms — a fixed
    /// buffer flushing, and the cause of the freezes testers reported for years. Reading the source
    /// once and broadcasting `-f mpjpeg` measures as clean as the source itself.
    Rtsp { url: &'a str, transcode: RtspTranscode },
}

/// How an RTSP source's video becomes the MJPEG the multipart sink needs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RtspTranscode {
    /// The source already sends MJPEG — pass its packets through untouched. No decode, no encode.
    Copy,
    /// Pi-class SoC: hardware H.264 decode, software MJPEG encode (no V4L2 M2M MJPEG encoder exists).
    V4l2m2m,
    /// Desktop GPU: both halves on the GPU, the frames never leaving it. Carries the render node.
    Vaapi(&'static str),
    Software,
}

impl RtspTranscode {
    /// The label the UI shows for the running pipeline — the pipeline that IS running, not what the
    /// host could do.
    pub fn label(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::V4l2m2m => "v4l2m2m",
            Self::Vaapi(_) => "vaapi",
            Self::Software => "software",
        }
    }
}

#[derive(Default)]
pub struct MjpegServer {
    inner: Mutex<Option<Running>>,
}

struct Running {
    ffmpeg: Child,
    shutdown: Arc<AtomicBool>,
    _accept: JoinHandle<()>,
    _reader: JoinHandle<()>,
    _stderr: JoinHandle<()>,
}

impl MjpegServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start the MJPEG server. Spawns ffmpeg to read `source` and output MJPEG (stream-copied where
    /// the input already carries it, transcoded otherwise), then broadcasts its stdout to all
    /// connected HTTP clients.
    ///
    /// Returns the port **only once the source has actually delivered its first bytes** (up to
    /// `FIRST_FRAME_TIMEOUT`); otherwise everything is torn down again and the error carries ffmpeg's
    /// own first stderr line. Blocking by design — call it from an async command.
    pub fn start(&self, source: &MjpegSource) -> Result<u16, String> {
        self.stop();

        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
        // Non-blocking so the accept loop can break out on shutdown.
        listener.set_nonblocking(true).map_err(|e| format!("set_nonblocking: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("addr: {e}"))?.port();

        // Resolve ffmpeg through the project's managed discovery (auto-download
        // on demand for Win/Linux, bundled on macOS). Falls back to "ffmpeg" if
        // not found (the error message will guide the user to install it).
        let ffmpeg_bin = super::ffmpeg::find_ffmpeg()
            .unwrap_or_else(|| std::path::PathBuf::from("ffmpeg"));

        // Build: [loglevel] + input (device or network) + output codec + mpjpeg mux (flushing per
        // packet). `-fflags nobuffer` and the hardware decoder selection are INPUT options, so they
        // precede the demuxer / `-i`.
        let mut args: Vec<String> = vec!["-loglevel".into(), "error".into()];
        match source {
            MjpegSource::Device(spec) => {
                args.extend(["-fflags".into(), "nobuffer".into()]);
                args.extend(super::native::input_args(spec));
                if super::native::needs_transcode(&spec.codec) {
                    // Raw / H.264 / auto → re-encode to MJPEG for the multipart sink.
                    args.extend(["-c:v".into(), "mjpeg".into(), "-q:v".into(), "5".into()]);
                } else {
                    // The camera already emits MJPEG: pass the packets straight through. No decode, no
                    // encode, no colour conversion — cheaper than any hardware transcode could ever be,
                    // so there is deliberately nothing to accelerate here.
                    args.extend(["-c".into(), "copy".into()]);
                }
            }
            MjpegSource::Rtsp { url, transcode } => {
                match transcode {
                    RtspTranscode::V4l2m2m => args.extend(["-c:v".into(), "h264_v4l2m2m".into()]),
                    RtspTranscode::Vaapi(node) => args.extend([
                        "-hwaccel".into(),
                        "vaapi".into(),
                        "-hwaccel_device".into(),
                        (*node).into(),
                        // Load-bearing: keeps decoded frames in GPU memory for the encoder below.
                        // Without it every frame is copied back to system memory and the chain ends
                        // up SLOWER than software.
                        "-hwaccel_output_format".into(),
                        "vaapi".into(),
                    ]),
                    RtspTranscode::Copy | RtspTranscode::Software => {}
                }
                // Deliberately NO `-rtsp_transport`: forcing one is what stops a UDP-only server
                // (the UAV-Link class) from opening at all, while ffmpeg's own negotiation reads
                // both. `-timeout` is in microseconds and makes a dead source exit rather than hang,
                // which is what lets the frontend notice and reconnect.
                //
                // 10 s to match the WebRTC path's live-stall window (`RTSP_STALL_LIVE_MS`), so both
                // readers tolerate the same LTE radio hole. go2rtc used 5 s here; UDP fires blind, so
                // the longer window is the better trade — and a stream abandoned mid-flight is
                // reaped server-side after 60 s anyway, which bounds how many can pile up.
                args.extend([
                    "-fflags".into(),
                    "nobuffer".into(),
                    "-flags".into(),
                    "low_delay".into(),
                    "-timeout".into(),
                    "10000000".into(),
                    "-i".into(),
                    (*url).into(),
                    "-an".into(),
                ]);
                match transcode {
                    RtspTranscode::Copy => args.extend(["-c".into(), "copy".into()]),
                    // `-async_depth 1`: the VAAPI encoders pipeline 2 frames by default for
                    // throughput, which on a live feed is simply latency — we want the frame out,
                    // not the frame rate.
                    RtspTranscode::Vaapi(_) => args.extend([
                        "-c:v".into(),
                        "mjpeg_vaapi".into(),
                        "-async_depth".into(),
                        "1".into(),
                    ]),
                    RtspTranscode::V4l2m2m | RtspTranscode::Software => {
                        args.extend(["-c:v".into(), "mjpeg".into(), "-q:v".into(), "5".into()])
                    }
                }
            }
        }
        // Emit each packet immediately (no output buffering) → even, low-jitter frame delivery.
        args.extend(["-flush_packets".into(), "1".into(), "-f".into(), "mpjpeg".into(), "-".into()]);

        let mut cmd = Command::new(&ffmpeg_bin);
        crate::child_env::sanitize(&mut cmd);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()) // capture ffmpeg errors for the log (tester diagnostics)
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — don't flash a console
        }
        let mut ffmpeg = cmd
            .spawn()
            .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

        let stdout = ffmpeg.stdout.take().ok_or("no stdout")?;
        let stderr = ffmpeg.stderr.take();
        let shutdown = Arc::new(AtomicBool::new(false));
        let clients: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
        // First-frame signal + the first ffmpeg error line, so a failed capture can be reported to the
        // caller instead of only reaching the log.
        let (first_tx, first_rx) = std::sync::mpsc::channel();
        let first_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let accept = {
            let clients = clients.clone();
            let shutdown = shutdown.clone();
            thread::spawn(move || accept_loop(listener, clients, shutdown))
        };
        let reader = {
            let shutdown = shutdown.clone();
            thread::spawn(move || broadcast_loop(stdout, clients, shutdown, Some(first_tx)))
        };
        let stderr_thread = {
            let first_err = first_err.clone();
            thread::spawn(move || log_ffmpeg_stderr(stderr, first_err))
        };

        // Don't report success until the capture actually delivers. Previously `start()` returned as
        // soon as the listener was bound, so a device that rejects the requested mode (AVFoundation and
        // DirectShow both abort hard) left the UI showing "live" over a black frame, with the reason
        // only in the log.
        if let Err(reason) = wait_for_first_frame(&mut ffmpeg, &first_rx) {
            shutdown.store(true, Ordering::SeqCst);
            let _ = ffmpeg.kill();
            let _ = ffmpeg.wait();
            let _ = reader.join();
            let _ = accept.join();
            let _ = stderr_thread.join(); // stderr is at EOF now → the error line is recorded
            let detail = first_err.lock().ok().and_then(|g| g.clone());
            let msg = match detail {
                Some(line) => format!("{reason}: {line}"),
                None => reason,
            };
            let what = match source {
                MjpegSource::Device(_) => "native capture",
                MjpegSource::Rtsp { .. } => "the RTSP MJPEG reader",
            };
            log::warn!("[video] {what} failed to start — {msg}");
            return Err(msg);
        }

        self.inner.lock().unwrap().replace(Running {
            ffmpeg,
            shutdown,
            _accept: accept,
            _reader: reader,
            _stderr: stderr_thread,
        });
        Ok(port)
    }

    pub fn stop(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut r) = guard.take() {
            // Signal both threads, then kill ffmpeg — closing stdout unblocks the reader's read().
            r.shutdown.store(true, Ordering::SeqCst);
            let _ = r.ffmpeg.kill();
            let _ = r.ffmpeg.wait();
            let _ = r._reader.join();
            let _ = r._accept.join();
            let _ = r._stderr.join();
            log::info!("MJPEG server stopped");
        }
    }
}

impl Drop for MjpegServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Block until the capture produced its first bytes, ffmpeg died, or the grace period ran out.
/// A dropped sender (channel `Disconnected`) means the broadcast loop hit stdout EOF — i.e. ffmpeg
/// exited before delivering anything, which is the common "device rejected the mode" case.
fn wait_for_first_frame(child: &mut Child, rx: &Receiver<()>) -> Result<(), String> {
    let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(()) => return Ok(()),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("the capture ended immediately".to_string());
            }
            Err(RecvTimeoutError::Timeout) => {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return Err("ffmpeg exited without delivering a frame".to_string());
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "no video from the source within {} s",
                        FIRST_FRAME_TIMEOUT.as_secs()
                    ));
                }
            }
        }
    }
}

/// Accept clients and register them for broadcast. Each gets the multipart preamble, `TCP_NODELAY`
/// (no Nagle bunching on localhost), and blocking writes. Exits when `shutdown` is set.
fn accept_loop(listener: TcpListener, clients: Arc<Mutex<Vec<TcpStream>>>, shutdown: Arc<AtomicBool>) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nodelay(true);
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
                if stream.write_all(HTTP_HEADERS).is_ok() && stream.flush().is_ok() {
                    clients.lock().unwrap().push(stream);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }
}

/// Read ffmpeg's stdout and write each chunk to every connected client, dropping clients that error
/// (a disconnected sink). Always drains stdout even with no clients so ffmpeg never blocks on a full
/// pipe. Exits on EOF (ffmpeg died) or shutdown, and **closes every client on the way out**: a
/// consumer whose socket stays open with no data has no way to tell a dead feed from a quiet one, so
/// leaving them connected left a permanently frozen picture instead of triggering a reconnect.
fn broadcast_loop(
    mut stdout: impl Read,
    clients: Arc<Mutex<Vec<TcpStream>>>,
    shutdown: Arc<AtomicBool>,
    mut first: Option<Sender<()>>,
) {
    let mut buf = [0u8; 65536];
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let n = match stdout.read(&mut buf) {
            Ok(0) => {
                // stdout EOF = ffmpeg exited. If we didn't ask it to stop, that's the "goes black"
                // failure — surface it (the stderr logger prints ffmpeg's reason just above).
                if !shutdown.load(Ordering::SeqCst) {
                    log::warn!("[video] MJPEG source ended unexpectedly (ffmpeg exited)");
                }
                break;
            }
            Ok(n) => n,
            Err(e) => {
                if !shutdown.load(Ordering::SeqCst) {
                    log::warn!("[video] MJPEG read error: {e}");
                }
                break;
            }
        };
        // Signal the successful start exactly once, then drop the sender so `start()` learns about a
        // later EOF through the closed channel.
        if let Some(tx) = first.take() {
            let _ = tx.send(());
        }
        let mut list = clients.lock().unwrap();
        if list.is_empty() {
            continue; // stdout already drained above
        }
        list.retain_mut(|c| c.write_all(&buf[..n]).is_ok());
    }
    // The source is gone. Stop accepting, and drop every client socket so the sinks see their stream
    // end and the frontend can reconnect instead of staring at a frozen frame.
    shutdown.store(true, Ordering::SeqCst);
    clients.lock().unwrap().clear();
}

/// Forward ffmpeg's stderr to the log. With `-loglevel error` these are genuine errors (device lost,
/// corrupt frame, codec failure) → tester-relevant, so they go at the default-visible `warn` level.
/// The **first** line is also recorded in `first_err` so a start-up failure can be reported to the UI
/// with ffmpeg's own wording (e.g. "Selected video size is not supported by the device").
fn log_ffmpeg_stderr(stderr: Option<ChildStderr>, first_err: Arc<Mutex<Option<String>>>) {
    let Some(stderr) = stderr else { return };
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        let line = line.trim();
        if !line.is_empty() {
            if let Ok(mut slot) = first_err.lock() {
                slot.get_or_insert_with(|| line.to_string());
            }
            log::warn!("[video][ffmpeg] {line}");
        }
    }
}
