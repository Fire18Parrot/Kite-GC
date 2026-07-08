// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Embedded MJPEG-over-HTTP server for native capture devices (V4L2 / DirectShow / AVFoundation).
//!
//! Spawns `ffmpeg -f <demuxer> … -f mpjpeg -` and **broadcasts** its stdout to every connected HTTP
//! client as a `multipart/x-mixed-replace` stream on a local port. Multiple sinks (panel preview,
//! floating window, dock widget) each open their own `<img>` on the same URL — one ffmpeg
//! decode/transcode fans out to all of them. The per-OS input + codec handling lives in
//! `video/native.rs`.
//!
//! Sockets get `TCP_NODELAY` and ffmpeg flushes per packet, so localhost delivery isn't bunched by
//! Nagle/output buffering (which shows up as sporadic stutter, worse at 60 fps).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Drop a client that can't accept data within this window — prevents one stalled `<img>` (e.g. an
/// occluded/throttled view) from blocking the shared broadcast (and back-pressuring ffmpeg).
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// The multipart HTTP response preamble sent once per client before the frame stream.
const HTTP_HEADERS: &[u8] = b"HTTP/1.1 200 OK\r\n\
    Content-Type: multipart/x-mixed-replace; boundary=ffmpeg\r\n\
    Cache-Control: no-cache\r\n\
    Connection: close\r\n\
    \r\n";

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

    /// Start the MJPEG server. Spawns ffmpeg to capture from a native device per `spec` and output
    /// MJPEG (stream-copied when the input is already MJPEG, transcoded otherwise), then broadcasts its
    /// stdout to all connected HTTP clients. Returns the port.
    pub fn start(&self, spec: &super::native::CaptureSpec) -> Result<u16, String> {
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

        // Build: [loglevel] + per-OS input (native) + output codec + mpjpeg mux (flushing per packet).
        // `-fflags nobuffer` (an input option, so it precedes the demuxer/-i) cuts input-side buffering
        // for lower latency and tighter pacing on live capture.
        let mut args: Vec<String> = vec![
            "-loglevel".into(),
            "error".into(),
            "-fflags".into(),
            "nobuffer".into(),
        ];
        args.extend(super::native::input_args(spec));
        if super::native::needs_transcode(&spec.codec) {
            // Raw / H.264 / auto → re-encode to MJPEG for the multipart sink.
            args.extend(["-c:v".into(), "mjpeg".into(), "-q:v".into(), "5".into()]);
        } else {
            args.extend(["-c".into(), "copy".into()]);
        }
        // Emit each packet immediately (no output buffering) → even, low-jitter frame delivery.
        args.extend(["-flush_packets".into(), "1".into(), "-f".into(), "mpjpeg".into(), "-".into()]);

        let mut cmd = Command::new(&ffmpeg_bin);
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

        let accept = {
            let clients = clients.clone();
            let shutdown = shutdown.clone();
            thread::spawn(move || accept_loop(listener, clients, shutdown))
        };
        let reader = {
            let shutdown = shutdown.clone();
            thread::spawn(move || broadcast_loop(stdout, clients, shutdown))
        };
        let stderr_thread = thread::spawn(move || log_ffmpeg_stderr(stderr));

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
/// (disconnected `<img>`). Always drains stdout even with no clients so ffmpeg never blocks on a full
/// pipe. Exits on EOF (ffmpeg died) or shutdown.
fn broadcast_loop(mut stdout: impl Read, clients: Arc<Mutex<Vec<TcpStream>>>, shutdown: Arc<AtomicBool>) {
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
                    log::warn!("[video] native MJPEG source ended unexpectedly (ffmpeg exited)");
                }
                break;
            }
            Ok(n) => n,
            Err(e) => {
                if !shutdown.load(Ordering::SeqCst) {
                    log::warn!("[video] native MJPEG read error: {e}");
                }
                break;
            }
        };
        let mut list = clients.lock().unwrap();
        if list.is_empty() {
            continue; // stdout already drained above
        }
        list.retain_mut(|c| c.write_all(&buf[..n]).is_ok());
    }
}

/// Forward ffmpeg's stderr to the log. With `-loglevel error` these are genuine errors (device lost,
/// corrupt frame, codec failure) → tester-relevant, so they go at the default-visible `warn` level.
fn log_ffmpeg_stderr(stderr: Option<ChildStderr>) {
    let Some(stderr) = stderr else { return };
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        let line = line.trim();
        if !line.is_empty() {
            log::warn!("[video][ffmpeg] {line}");
        }
    }
}
