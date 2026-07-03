// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Embedded MJPEG-over-HTTP server for V4L2 capture devices.
//!
//! Spawns `ffmpeg -f v4l2 … -f mpjpeg -` and serves its stdout as a
//! `multipart/x-mixed-replace` HTTP stream on a local port. The frontend
//! renders this directly in an `<img>` tag — no WebRTC or go2rtc needed.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Default)]
pub struct MjpegServer {
    inner: Mutex<Option<Running>>,
}

struct Running {
    ffmpeg: Child,
    shutdown: Arc<AtomicBool>,
    _thread: JoinHandle<()>,
}

impl MjpegServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start the MJPEG server. Spawns ffmpeg to capture from a V4L2 device and
    /// output MJPEG, then pipes its stdout to HTTP clients. Returns the port.
    pub fn start(&self, device: &str, width: u32, height: u32) -> Result<u16, String> {
        self.stop();

        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
        // Non-blocking so we can break out of accept() on shutdown.
        listener.set_nonblocking(true).map_err(|e| format!("set_nonblocking: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("addr: {e}"))?.port();

        let mut ffmpeg = Command::new("ffmpeg")
            .args([
                "-loglevel", "error",
                "-f", "v4l2",
                "-input_format", "mjpeg",
                "-video_size", &format!("{width}x{height}"),
                "-i", device,
                "-c", "copy",
                "-f", "mpjpeg",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

        let mut stdout = ffmpeg.stdout.take().ok_or("no stdout")?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_flag = shutdown.clone();

        let handle = thread::spawn(move || {
            serve_mjpeg(listener, &mut stdout, &shutdown_flag);
        });

        self.inner.lock().unwrap().replace(Running {
            ffmpeg,
            shutdown,
            _thread: handle,
        });
        Ok(port)
    }

    pub fn stop(&self) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut r) = guard.take() {
            // Signal the server thread to stop, then wait for it.
            r.shutdown.store(true, Ordering::SeqCst);
            // Kill ffmpeg — this closes stdout, which unblocks the server thread's read.
            let _ = r.ffmpeg.kill();
            let _ = r.ffmpeg.wait();
            // Wait up to 2 seconds for the server thread to finish.
            let _ = r._thread.join();
            log::info!("MJPEG server stopped");
        }
    }
}

impl Drop for MjpegServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Accept clients in a loop, serving the MJPEG stream to one client at a time.
/// Exits when `shutdown` is set or ffmpeg dies (stdout EOF).
fn serve_mjpeg(
    listener: TcpListener,
    stdout: &mut impl Read,
    shutdown: &AtomicBool,
) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                serve_client(stream, stdout);
                // After client disconnects, loop to accept another (reconnect).
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No connection pending — check shutdown flag and retry.
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(_) => break,
        }
    }
}

fn serve_client(mut stream: TcpStream, stdout: &mut impl Read) {
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\n\
          Content-Type: multipart/x-mixed-replace; boundary=ffmpeg\r\n\
          Cache-Control: no-cache\r\n\
          Connection: close\r\n\
          \r\n",
    );
    let _ = stream.flush();
    let mut buf = [0u8; 65536];
    while let Ok(n) = stdout.read(&mut buf) {
        if n == 0 {
            break;
        }
        if stream.write_all(&buf[..n]).is_err() {
            break;
        }
    }
}
