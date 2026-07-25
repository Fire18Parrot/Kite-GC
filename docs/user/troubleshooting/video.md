# Video problems

Trouble getting a feed? Work through the checks below. For how the video feature works in the first
place, see the **[Video guide](../guides/video.md)**.

## A local camera / capture card doesn't appear

- **Connect it before opening the source list**, then reopen the **Camera** dropdown — devices are
  enumerated when the list opens.
- **Close other apps using it.** A webcam or capture card can usually be opened by **one app at a time**;
  quit anything else holding it (OBS, a browser tab, another GCS).
- **Check OS permissions.** The operating system may need to grant camera access to Kite.
- **Try Native Capture (Advanced).** Some capture devices — notably certain USB HDMI dongles, especially
  on Linux — aren't exposed to the ordinary **Camera** list but *are* reachable through **Native Capture
  (Advanced)**. Switch the source kind and reopen the device dropdown. (Native Capture uses the **ffmpeg**
  helper, which Kite downloads automatically the first time.)

## An RTSP stream won't start

RTSP playback uses a small bundled engine (**go2rtc**); Kite downloads it automatically the first time
you start an RTSP source. If a stream won't come up:

- **Let the engine download finish.** The Video panel shows the go2rtc status and offers the download if
  it's missing — RTSP can't play until it's installed. If the download fails (no internet, or an
  unsupported CPU architecture), you'll get a hint to install it manually.
- **Check the URL and reachability.** A typo, a camera that's off, a firewall, or a source on a different
  network will all stop it. Confirm the exact `rtsp://…` URL works in another player (e.g. VLC) from the
  same machine.
- **Match the transport.** Some servers are **UDP-only** (they reject TCP clients) — set the connection's
  **Transport** to **UDP** in the Video panel (needs the ffmpeg helper). Conversely, if UDP is blocked on
  your network, try **TCP**. **Auto** tries the native reader first and falls back to ffmpeg.

## The stream keeps showing "Reconnecting…"

The overlay means Kite lost the feed and is retrying — it will **keep trying until the stream returns or
you press Stop**. If it never comes back: the source is down or unreachable (check it in another player),
the transport doesn't match the server (see above), or a firewall started blocking the media packets. A
few reconnect cycles in a row are normal when a source restarts or the network path changes (e.g.
switching between Wi-Fi and a cellular link).

## The picture stutters or shows "frames out of order"

This is almost always the **source encoder**, not Kite. The live path uses WebRTC, which tolerates
**B-frames** poorly:

- **Real FPV / DJI / IP-camera** streams are usually fine (no B-frames).
- **OBS** and similar software encoders must be set to **B-frames = 0**, a **baseline / main** profile and
  an **ultra-low-latency** tuning to play smoothly.

This is a property of the stream Kite receives — it can't be fixed downstream for a pass-through feed.

## A specific RTSP server gives a black screen

Some servers (notably the **OBS RTSP server**) reject go2rtc's native reader. Kite automatically retries
such sources through an **ffmpeg fallback** reader — but that needs **ffmpeg**, which is a separate
optional download:

- The Video panel offers an **ffmpeg (fallback)** download when it's missing. Install it and start the
  stream again.
- The panel shows **which reader is live** (go2rtc native vs the ffmpeg fallback), so you can tell which
  path your source is using.

## Latency is high

With a sensibly-configured encoder, end-to-end latency is low (roughly a couple of hundred milliseconds).
If it's much worse, the cause is usually the **source**: a large keyframe interval, a big encoder buffer,
or a non-low-latency tuning. Tune the encoder/camera for low-latency streaming.

## Linux: high CPU load, stuttering, or "Reconnecting…" that never settles

On Linux, Kite depends on your distribution's browser-engine and GStreamer packages for all video work
— see the **[platform notes](../guides/video.md#platform-notes-what-to-expect-per-operating-system)**
in the guide for what that means. The log tells you exactly what your system offers. Set **Settings →
Diagnostics → Log Level** to **Warning** (the default is enough), restart Kite, start your stream, then
open the log and look for these lines:

```
[webkit] WebKitGTK 2.xx.y — enable-webrtc set, reads back as true
[gstreamer] webrtcbin=false · h264 decoders=[] — …
WebRTC is unavailable in this WebView — falling back to the MJPEG image path
```

- **`webrtcbin=false`** — the efficient direct path is unavailable, so Kite converts the stream frame by
  frame, which is what drives the CPU up. Install the plugin package and restart:
  ```bash
  sudo apt install gstreamer1.0-plugins-bad     # Debian / Ubuntu / Raspberry Pi OS
  ```
- **`h264 decoders=[]`** — no H.264 decoder is installed at all; add `gstreamer1.0-libav` as well.
- **"WebRTC is unavailable …"** without either of the above — your engine build genuinely has no WebRTC.
  The converted-image path still gives you a picture; reducing the source resolution or frame rate at the
  camera end is then the effective lever.

If the CPU stays high even with a small picture, that is the conversion itself, not Kite's interface.
Software conversion of a 720p60 stream is beyond a single-board computer regardless of settings.

## Raspberry Pi: garbled or black window right after start

A known quirk of the Pi's graphics driver: the very first drawing surface is often invalid. Kite detects
a Raspberry Pi and briefly resizes its own window once the interface has loaded, which forces a clean
surface. If you still see it, the log line `[gpu] Raspberry Pi framebuffer nudge: …` tells you the
workaround ran and which variant it used.

## Still stuck?

Grab a **diagnostic log** (**Settings → Diagnostics → Log Level = Debug**, reproduce, then **Open Log
Folder**) and attach it when reporting the problem — it records the go2rtc / ffmpeg startup and any error.
See the [connection troubleshooting](connection.md#getting-a-diagnostic-log) page for the log locations.
