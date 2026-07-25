# Video

Kite can show a live video feed alongside (or behind) the map — a **local capture device** such as a
webcam or USB capture card, or an **RTSP stream** from a network video source. Open it from the
**Video** tool on the navigation rail.

## Choosing a source

Pick the **source kind** from the dropdown, set it up, then **Start** / **Stop** the feed. Your choice
is remembered between sessions.

- **Camera (device)** — a local capture device opened the simple way, through the system's built-in
  camera access. Choose a device from the dropdown (webcams and capture cards the system exposes are
  listed automatically). No extra downloads.
- **Native Capture (Advanced)** — a local capture device opened via Kite's capture engine for **more
  control and wider device support**. See the comparison below.
- **RTSP (network)** — enter the stream URL (e.g. from your video receiver or an RTSP server), pick a
  **transport**, and optionally **save the connection** to a list for one-click recall — see
  **[RTSP connections](#rtsp-connections-transport-and-auto-reconnect)** below.

![The Video panel](../assets/guides/video/video_panel.png)
/// caption
The Video panel — source kind, device / RTSP URL, resolution, frame rate and mirror, with Start/Stop.
///

### Camera (device) vs Native Capture — which should I use?

Both play a local capture device; they differ in **how** they open it.

| | **Camera (device)** | **Native Capture (Advanced)** |
|---|---|---|
| Setup | Nothing to install | Needs the **ffmpeg** helper (downloaded automatically) |
| Device list | What the system exposes to apps | Read directly from the capture hardware — **can find devices the Camera list doesn't show** (e.g. some USB HDMI capture dongles) |
| Resolution / frame rate | A **request** — Auto / 720p / 1080p and an optional 30 / 60 fps wish; the camera picks the closest mode it supports | **Device-verified** — only the resolutions and frame rates your device actually reports (from a curated FPV set: SD PAL/NTSC, 480p, 720p, 1080p, 1440p) |
| Codec | Chosen automatically | Chosen automatically to hit the selected resolution/frame rate |

**Start with Camera (device).** Switch to **Native Capture (Advanced)** if your device isn't listed
under Camera, or when you want to pin an exact resolution / frame rate that the device confirms it
supports. Both deliver the same smooth, hardware-accelerated picture for devices the system can open;
Native additionally reaches devices that only the capture engine can see.

### Resolution, frame rate and mirror

- **Resolution** — Camera offers Auto / 720p / 1080p; Native offers the device-verified list.
- **Frame rate** — Camera offers Auto / 30 / 60 fps; Native offers the frame rates the device reports
  for the chosen resolution.
- **Mirror** — flip the image horizontally (handy for front-facing cameras). Applies to every place the
  feed is shown.

### RTSP connections, transport and auto-reconnect

The RTSP source has a small **connection manager** built in:

- **Direct connect** — type the `rtsp://…` URL and press Start. Next to the URL sits the **transport**
  selector:
    - **Auto** (default) — tries the engine's native reader first, then the ffmpeg fallback. Right for
      most sources.
    - **UDP** — lowest latency; **required for UDP-only servers** (some FPV / air-unit streamers). Uses
      the ffmpeg helper.
    - **TCP** — for sources that only speak interleaved TCP, or when UDP is blocked by the network.
- **Save it** — the **💾 button** stores the current URL + transport as a named entry (named after the
  host; rename it via ✎). Connections are **only saved when you press the button** — never
  automatically.
- **Low-CPU mode (MediaSource)** — a per-machine option, off by default. It hands the stream to the
  system's own video decoder instead of converting it, which cuts CPU load dramatically and makes higher
  resolutions possible on weak hardware — but the picture runs roughly a second behind. Intended for
  machines that can't sustain the normal path (see the [platform notes](#platform-notes-what-to-expect-per-operating-system));
  leave it off whenever latency matters.
- **Converted stream size** (Linux only) — when the stream plays over the **converted fallback path**
  (see the platform notes), this scales it down **before** conversion: Original, 960 px or 640 px wide.
  A smaller size cuts the conversion CPU load sharply on both ends with no extra delay. Pick a size close
  to how large the video is actually shown on screen — the picture only gets softer when it is displayed
  larger than the chosen size. Has no effect on the direct playback path.
- **The list** — each saved connection is a one-line entry: **click it to load and connect**, ✎ edits
  name / URL / transport inline, ✕ removes it. The entry matching the current URL is highlighted.

**Auto-reconnect:** if a running RTSP feed drops or stalls — a radio hole on a cellular link, the
source restarting, a network change — Kite **reconnects automatically and keeps trying indefinitely**
until the feed returns or you stop it. While it retries, every video surface shows a
**"Reconnecting… (n)"** overlay with the attempt count and a **Stop** button. Brief dropouts on a live
feed are given a few seconds to heal on their own before a full reconnect is forced, so momentary
signal dips don't interrupt the stream unnecessarily.

!!! note "Helpers download themselves"
    **Camera (device)** needs nothing extra. **Native Capture** uses the bundled **ffmpeg** engine, and
    **RTSP** uses **go2rtc** (with ffmpeg as a fallback reader for streams it can't read natively). Kite
    downloads whichever it needs **automatically** the first time you use that source — no manual
    install. On macOS these are shipped with the app.

## Where the video shows

The same feed can appear in several places at once (they all share one stream):

- **In the panel** — a preview right in the Video panel.
- **As a widget** — the **Video** widget in a dock, sized to the stream's aspect ratio.
- **In a floating window** — a movable video frame over the map. **Drag the video body** to move it;
  dragging it to the **bottom-left corner snaps it there**, where it **displaces the bottom widget dock**
  to make room (the dock shrinks by the window's size). Drag it away from the corner to un-snap and
  free-float. The **top-right corner grip resizes** it (aspect-locked, touch-friendly).
- **In a detached window** (**Windows only** — see the [platform notes](#platform-notes-what-to-expect-per-operating-system);
  the button is simply absent elsewhere) — a separate, free-floating **OS window** you can place anywhere,
  including **outside the app** or on a second monitor. Opened from the Video panel; because it lives outside the
  app it's closed from the OS (not from inside Kite), and — unlike the floating window — it **can't host
  the map** (no swap). It's also the **lightest** option: the OS draws it directly, so on low-power
  systems using only the detached window keeps GPU load to a minimum.

![The floating video window and the video widget](../assets/guides/video/video_floating_widget.png)
/// caption
The floating video window (over the map) and the dockable Video widget — both showing the same feed.
///

## Map ↔ video swap

**Double-click a video surface** (the Video widget or the floating window) to **swap it with the map**:
the map jumps *into* the surface you clicked and the video moves out to the full-screen background — so
you get **video as your main view with the map in the small frame**. Double-click again to send the map
back to the full-screen background.

How interactive the swapped-in **mini-map** is depends on where it landed:

- **In the widget** — deliberately limited by space: **2D only** and **heading-follow only**, but you
  **can zoom**.
- **In the floating window** — fully interactive: pan and zoom normally (left-drag / single-touch). To
  **move the floating frame itself** while it holds the map, drag with the **right mouse button**
  (desktop) or **two fingers** (touchscreen).

![The map swapped into the video — mini-map over a full-screen feed](../assets/guides/video/video_map_swap.png)
/// caption
Swapped: the live video fills the background while the map rides in the smaller frame.
///

## Platform notes: what to expect per operating system

Video is the one part of Kite that depends heavily on components Kite does **not** ship: the operating
system's built-in browser engine and its media plugins. That works out very differently per platform,
and it is only fair to say so plainly.

**Windows and macOS are the more predictable hosts for video.** Both ship a single, consistent media
stack, so a network stream is played directly by the system's hardware-accelerated decoder. If a smooth,
low-CPU, low-latency feed is important to you — and especially if you plan to fly with it — those are
the platforms we can most confidently recommend.

**On Linux, video support is provided as-is.** Kite runs in WebKitGTK there, which delegates all video
work to GStreamer — and which plugins your distribution installs is entirely up to your distribution.
There are hundreds of combinations of distro, desktop, graphics driver and plugin set, and we cannot
test or support them all. Concretely, these are things Kite cannot fix from its side:

- **Whether an RTSP stream can be played directly at all.** Several distributions — Raspberry Pi OS
  among them — ship a browser engine built **without** the direct (WebRTC) video path, and that cannot
  be installed after the fact. Kite then falls back to a **converted image stream**: it still works, but
  every frame is decoded and re-encoded, which costs **considerably more CPU** and on a small machine
  means a stuttering picture at higher resolutions. For those machines the Video panel offers
  **Low-CPU mode (MediaSource)**, which plays the stream directly instead of converting it — much less
  load and higher resolutions, at the price of roughly a second of extra delay. Kite records what your
  system provides in the diagnostic log, so you can see which path you're on (see
  **[Video troubleshooting](../troubleshooting/video.md)**).
- **Whether decoding uses the graphics hardware.** Hardware video decoding depends on your driver and
  the installed plugins, and on some machines it simply isn't available — everything is then done on the
  CPU. We cannot guarantee hardware decoding on Linux, and single-board computers with no H.264 decoder
  in hardware (the Raspberry Pi 5, for example) will always decode in software.
- **Local camera quirks.** On Linux the system camera layer can be slow or unresponsive on some setups.
  Kite works around the worst cases (it caps the automatic resolution and frame rate, and routes the
  advanced capture path around that layer entirely), but a camera the system itself can't open cleanly
  is out of reach.
- **Picture-in-Picture** (the detached "Video Window") is a Windows-only feature — neither the Linux nor
  the macOS browser engine offers the interface Kite would need for it. All the in-app surfaces
  (panel, widget, floating window, full-screen swap) work everywhere.

None of this means Linux is unusable — a well-equipped desktop distribution generally plays video fine,
and it is a first-class platform for everything else Kite does. It only means that **if video is your
priority, Linux is the platform where you may have to do some work yourself**, and we can't promise a
particular result on a particular machine.

## Where to go next

- Put the Video widget in a dock: **[Telemetry & display](telemetry-and-display.md)**.
- Trouble getting a stream? **[Video troubleshooting](../troubleshooting/video.md)**.
