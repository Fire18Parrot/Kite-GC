<!--
  SPDX-License-Identifier: GPL-3.0-or-later
  Copyright (C) 2026 Marc Hoffmann (b14ckyy)
-->

<script lang="ts">
  // Video control panel on the panel framework (docs/active/PANEL_FRAMEWORK.md): a `compact`
  // PanelShell. Header = Start/Stop; content = preview + source/resolution/mirror settings;
  // footer = Floating Window (mode button) + Video Window/detach (button).
  // Kept deliberately simple but extensible (more sinks/sources can slot into the content field).
  import { t } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import {
    videoState,
    videoStream,
    bindVideoEl,
    reportVideoSize,
    enumerateVideoDevices,
    toggleVideo,
    setVideoDevice,
    setVideoResolution,
    setCameraFps,
    setVideoMirror,
    setVideoKind,
    setRtspUrl,
    setRtspTransport,
    saveRtspConnection,
    updateRtspConnection,
    removeRtspConnection,
    selectRtspConnection,
    setRtspMse,
    setRtspMaxWidth,
    reportMjpegError,
    type RtspTransport,
    toggleFloating,
    enterPiP,
    pipSupported,
    type VideoResolution,
    type VideoKind,
    type CameraFps,
    enumerateNativeDevices,
    setNativeDevice,
    setNativeResolution,
    setNativeFramerate,
  } from '$lib/stores/video';
  import {
    resolutionsFor,
    frameratesFor,
    resolutionLabel,
  } from '$lib/helpers/videoCapabilities';
  import PanelShell from '$lib/components/panel/PanelShell.svelte';
  import Button from '$lib/components/panel/Button.svelte';
  import Toggle from '$lib/components/panel/Toggle.svelte';
  import { isLinux } from '$lib/platform';
  import VideoReconnectOverlay from '$lib/components/video/VideoReconnectOverlay.svelte';

  let videoEl = $state<HTMLVideoElement | null>(null);
  // Which saved RTSP connection is being edited inline (null = none).
  let editingRtspId = $state<string | null>(null);
  const inputVal = (e: Event) => (e.currentTarget as HTMLInputElement).value;

  // Bind the preview element to the shared MediaStream (camera or rtsp via captureStream).
  $effect(() => {
    bindVideoEl(videoEl, $videoStream);
  });

  // Populate the getUserMedia device list. It is only consumed by the `camera` source; on Linux,
  // enumerating it drives WebKit's GStreamer/pipewire stack, which can hang ~35 s on an unreachable
  // pipewire and freeze the app — so there we enumerate it only while the camera source is selected.
  // (The native list comes from the Rust backend and is enumerated once on mount, below.)
  //
  // The condition MUST come through this narrow $derived: an effect that reads `$videoState` directly
  // depends on the WHOLE store, and every enumeration writes back into it (devices / nativeDevices) —
  // which re-triggers the effect forever. That hit Linux only, because there the `||` short-circuit
  // does not skip the store read: a permanent enumerate → patch → enumerate loop (IPC + an ffmpeg
  // probe process + a localStorage write per round, and a stream restart when the saved device is
  // stale). A $derived boolean re-evaluates but only propagates when it actually flips.
  const needCameraList = $derived(!isLinux || $videoState.kind === 'camera');
  $effect(() => {
    if (needCameraList) void enumerateVideoDevices();
  });

  // ── RTSP / V4L2 dependencies ──────────────────────────────────────────
  // go2rtc is required (the RTSP→WebRTC engine); ffmpeg is the optional fallback reader for sources
  // go2rtc's native client can't read (e.g. obs-rtspserver), and the V4L2 path always uses it.
  // Both are downloaded on demand.
  let engineVer = $state<string | null>(null);
  let engineChecked = $state(false);
  let engineDownloading = $state(false);
  let enginePct = $state(0);
  let engineMsg = $state('');

  let ffmpegVer = $state<string | null>(null);
  let ffmpegChecked = $state(false);
  let ffmpegDownloading = $state(false);
  let ffmpegPct = $state(0);
  let ffmpegMsg = $state('');

  async function checkEngine(): Promise<void> {
    try {
      engineVer = await invoke<string | null>('video_go2rtc_status');
    } catch {
      engineVer = null;
    }
    engineChecked = true;
  }

  async function checkFfmpeg(): Promise<void> {
    try {
      ffmpegVer = await invoke<string | null>('video_ffmpeg_status');
    } catch {
      ffmpegVer = null;
    }
    ffmpegChecked = true;
  }

  async function downloadEngine(): Promise<void> {
    engineDownloading = true;
    enginePct = 0;
    engineMsg = '';
    try {
      await invoke('video_go2rtc_download');
      await checkEngine();
    } catch (e) {
      engineMsg = e instanceof Error ? e.message : String(e);
    } finally {
      engineDownloading = false;
    }
  }

  async function downloadFfmpeg(): Promise<void> {
    ffmpegDownloading = true;
    ffmpegPct = 0;
    ffmpegMsg = '';
    try {
      await invoke('video_ffmpeg_download');
      await checkFfmpeg();
      // On Windows/macOS enumeration itself needs ffmpeg — refresh the native device list now.
      void enumerateNativeDevices();
    } catch (e) {
      ffmpegMsg = e instanceof Error ? e.message : String(e);
    } finally {
      ffmpegDownloading = false;
    }
  }

  onMount(() => {
    void checkEngine();
    void checkFfmpeg();
    // Native capture devices: enumerated once per panel open (the Rust backend reads V4L2 sysfs /
    // DirectShow / AVFoundation). Deliberately NOT in an $effect — it writes `nativeDevices` back into
    // the video store, which would make any store-reading effect re-trigger itself (see above).
    void enumerateNativeDevices();
    const unlisteners: UnlistenFn[] = [];
    void listen<{ pct: number; msg: string }>('go2rtc-download-progress', (e) => {
      enginePct = e.payload.pct;
      engineMsg = e.payload.msg;
    }).then((u) => unlisteners.push(u));
    void listen<{ pct: number; msg: string }>('ffmpeg-download-progress', (e) => {
      ffmpegPct = e.payload.pct;
      ffmpegMsg = e.payload.msg;
    }).then((u) => unlisteners.push(u));
    return () => unlisteners.forEach((u) => u());
  });

  // Native capture is available on every OS (Linux V4L2 / Windows DirectShow / macOS AVFoundation).
  const KINDS: VideoKind[] = ['camera', 'rtsp', 'native'];

  // MJPEG FPS counter — onload fires per frame in multipart streams.
  let mjpegFps = $state(0);
  let _mjpegFrames = 0;
  let _mjpegLast = performance.now();
  // Per-frame hook of the MJPEG <img>: count for the fps meter AND report the picture size. The
  // <video> path gets width/height from onloadedmetadata, but an <img> feed never reported it — on
  // Linux/RTSP the info line showed dashes and the floating window kept the default 16:9 aspect even
  // for a 3:2 stream. naturalWidth is valid from the first displayed frame. (The fps half stays
  // engine-dependent: WebKitGTK fires load only once for a multipart image, so no rate is measurable
  // there — the resolution is, from that single event.)
  function mjpegFrame(e: Event): void {
    mjpegFrameTick();
    const img = e.currentTarget as HTMLImageElement;
    if (img.naturalWidth) reportVideoSize(img.naturalWidth, img.naturalHeight);
  }

  function mjpegFrameTick(): void {
    _mjpegFrames++;
    const now = performance.now();
    const dt = now - _mjpegLast;
    if (dt >= 1000) {
      mjpegFps = (_mjpegFrames * 1000) / dt;
      _mjpegFrames = 0;
      _mjpegLast = now;
    }
  }

  // Measured (real) frame rate via requestVideoFrameCallback. The live flag goes through a $derived
  // for the same reason as the enumeration above: reading `$videoState` inside the effect would make it
  // depend on the whole store, so every unrelated patch (each reconnect-attempt tick, every widget-rect
  // update) cancelled and re-registered the frame callback — resetting the counter each time.
  let measuredFps = $state(0);
  const feedLive = $derived($videoState.status === 'live');
  $effect(() => {
    const el = videoEl as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    }) | null;
    if (!el || !feedLive || !el.requestVideoFrameCallback) {
      measuredFps = 0;
      return;
    }
    let frames = 0;
    let last = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      frames++;
      const dt = now - last;
      if (dt >= 1000) {
        measuredFps = (frames * 1000) / dt;
        frames = 0;
        last = now;
      }
      handle = el.requestVideoFrameCallback!(tick);
    };
    handle = el.requestVideoFrameCallback(tick);
    return () => el.cancelVideoFrameCallback?.(handle);
  });

  const RESOLUTIONS: VideoResolution[] = ['auto', '720p', '1080p'];
  const CAMERA_FPS: CameraFps[] = ['auto', '30', '60'];

  // Native-capture cascade, derived from the probed modes (curated ∩ device). Codec is not a control
  // — getUserMedia (the primary path) picks it — so the cascade is resolution → framerate only.
  const nativeResolutions = $derived(resolutionsFor($videoState.nativeModes));
  const nativeFramerates = $derived(
    frameratesFor($videoState.nativeModes, $videoState.nativeSel.width, $videoState.nativeSel.height),
  );

  // Info-line frame rate. The native getUserMedia path (and camera) show measured/negotiated; the
  // native MJPEG fallback (<img> multipart) can't measure per-frame in WebView2 → show the configured
  // rate instead of a stuck 0.
  const fpsText = $derived.by(() => {
    const s = $videoState;
    if (s.kind === 'native' && s.mjpegUrl) return String(s.nativeSel.fps);
    const cur = s.mjpegUrl ? mjpegFps : measuredFps;
    const curStr = cur ? cur.toFixed(0) : '–';
    return s.frameRate ? `${curStr}/${Math.round(s.frameRate)}` : curStr;
  });
</script>

{#snippet headerActions()}
  <Button
    variant={$videoState.enabled ? 'danger' : 'data'}
    disabled={!$videoState.enabled && $videoState.kind === 'rtsp' && engineChecked && !engineVer}
    onclick={toggleVideo}
  >
    {$videoState.enabled ? $t('video.stop') : $t('video.start')}
  </Button>
{/snippet}

{#snippet body()}
  <div class="vp-body">
    <div class="preview" style="aspect-ratio: {$videoState.aspect};">
      {#if $videoState.mjpegUrl}
        <!-- MJPEG: embedded ffmpeg server, each frame triggers onload -->
        <!-- svelte-ignore a11y_missing_attribute -->
        <img
          src={$videoState.mjpegUrl}
          alt="Live video"
          class:mirror={$videoState.mirror}
          onload={mjpegFrame}
          onerror={reportMjpegError}
        />
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoEl}
          autoplay
          muted
          playsinline
          class:mirror={$videoState.mirror}
          class:hidden={$videoState.status !== 'live'}
          onloadedmetadata={(e) => reportVideoSize(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
          onerror={() => console.error('[video] element error', videoEl?.error?.code, videoEl?.error?.message)}
          onloadeddata={() => console.log('[video] loadeddata, readyState', videoEl?.readyState)}
          onstalled={() => console.warn('[video] stalled')}
          onwaiting={() => console.warn('[video] waiting/buffering')}
        ></video>
      {/if}
      {#if $videoState.status !== 'live' && !$videoState.mjpegUrl}
        <div class="preview-placeholder">
          {#if $videoState.status === 'starting'}
            {$t('video.starting')}
          {:else if $videoState.status === 'error'}
            ⚠ {$videoState.error}
          {:else}
            {$t('video.off')}
          {/if}
        </div>
      {/if}
      <VideoReconnectOverlay />
    </div>

    {#if $videoState.status === 'live'}
      <div class="info-line">
        {$videoState.width ?? '–'}×{$videoState.height ?? '–'}
        · {fpsText} fps
      </div>
    {/if}

    <label class="field">
      <span class="label">{$t('video.source')}</span>
      <select
        value={$videoState.kind}
        onchange={(e) => setVideoKind((e.currentTarget as HTMLSelectElement).value as VideoKind)}
      >
        {#each KINDS as k}
          <option value={k}>{$t(`video.kind.${k}`)}</option>
        {/each}
      </select>
    </label>

    {#if $videoState.kind === 'camera'}
      <label class="field">
        <span class="label">{$t('video.device')}</span>
        <select
          value={$videoState.deviceId ?? ''}
          onchange={(e) => setVideoDevice((e.currentTarget as HTMLSelectElement).value || null)}
        >
          <option value="">{$t('video.defaultDevice')}</option>
          {#each $videoState.devices as d}
            <option value={d.deviceId}>{d.label}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span class="label">{$t('video.resolution')}</span>
        <select
          value={$videoState.resolution}
          onchange={(e) => setVideoResolution((e.currentTarget as HTMLSelectElement).value as VideoResolution)}
        >
          {#each RESOLUTIONS as r}
            <option value={r}>{r === 'auto' ? $t('video.auto') : r}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span class="label">{$t('video.framerate')}</span>
        <select
          value={$videoState.cameraFps}
          onchange={(e) => setCameraFps((e.currentTarget as HTMLSelectElement).value as CameraFps)}
        >
          {#each CAMERA_FPS as f}
            <option value={f}>{f === 'auto' ? $t('video.auto') : `${f} fps`}</option>
          {/each}
        </select>
      </label>

      {#if $videoState.devices.length === 0}
        <p class="hint">{$t('video.noDevices')}</p>
      {/if}
    {:else if $videoState.kind === 'native'}
      <label class="field">
        <span class="label">{$t('video.device')}</span>
        <select
          value={$videoState.nativeDevice ?? ''}
          onchange={(e) => setNativeDevice((e.currentTarget as HTMLSelectElement).value || null)}
        >
          {#each $videoState.nativeDevices as d}
            <option value={d.id}>{d.name}</option>
          {/each}
        </select>
      </label>

      {#if $videoState.nativeDevices.length === 0}
        <p class="hint">{$t('video.noNativeDevices')}</p>
      {:else}
        <label class="field">
          <span class="label">{$t('video.resolution')}</span>
          <select
            value={`${$videoState.nativeSel.width}x${$videoState.nativeSel.height}`}
            onchange={(e) => {
              const [w, h] = (e.currentTarget as HTMLSelectElement).value.split('x').map(Number);
              void setNativeResolution(w, h);
            }}
          >
            {#each nativeResolutions as r}
              <option value={`${r.width}x${r.height}`}>{resolutionLabel(r.width, r.height)}</option>
            {/each}
          </select>
        </label>

        <label class="field">
          <span class="label">{$t('video.framerate')}</span>
          <select
            value={String($videoState.nativeSel.fps)}
            onchange={(e) => setNativeFramerate(Number((e.currentTarget as HTMLSelectElement).value))}
          >
            {#each nativeFramerates as f}
              <option value={String(f)}>{f} fps</option>
            {/each}
          </select>
        </label>
      {/if}

      <!-- Native capture needs ffmpeg (no go2rtc). -->
      {#if ffmpegChecked && !ffmpegVer}
        <div class="ffmpeg-box">
          <p class="hint">{$t('video.ffmpegNativeMissing')}</p>
          {#if ffmpegDownloading}
            <div class="dl-row">
              <div class="dl-bar"><div class="dl-fill" style="width:{ffmpegPct}%"></div></div>
              <span class="dl-pct">{ffmpegPct}%</span>
            </div>
            {#if ffmpegMsg}<p class="hint">{ffmpegMsg}</p>{/if}
          {:else}
            <Button variant="data" onclick={downloadFfmpeg}>{$t('video.ffmpegFallbackDownload')}</Button>
            {#if ffmpegMsg}<p class="hint err">{ffmpegMsg}</p>{/if}
          {/if}
        </div>
      {/if}
    {:else}
      <!-- Direct connect: URL + transport, with an explicit Save-to-list button (never auto-saved). -->
      <div class="field">
        <span class="label">{$t('video.rtspUrl')}</span>
        <div class="rtsp-url-row">
          <input
            class="text-input"
            type="text"
            placeholder="rtsp://192.168.1.10:554/cam"
            value={$videoState.rtspUrl}
            onchange={(e) => setRtspUrl(inputVal(e))}
          />
          <select
            class="rtsp-transport"
            value={$videoState.rtspTransport}
            title={$t('video.rtspTransportHint')}
            onchange={(e) => setRtspTransport((e.currentTarget as HTMLSelectElement).value as RtspTransport)}
          >
            <option value="auto">{$t('video.rtspAuto')}</option>
            <option value="udp">UDP</option>
            <option value="tcp">TCP</option>
          </select>
          <button
            class="rtsp-save"
            title={$t('video.rtspSave')}
            aria-label={$t('video.rtspSave')}
            disabled={!$videoState.rtspUrl.trim()}
            onclick={saveRtspConnection}
          >💾</button>
        </div>
      </div>

      <!-- Saved connections: single-line rows, selectable / editable / deletable (ADS-B-provider style). -->
      {#if $videoState.rtspConnections.length}
        <div class="rtsp-list">
          {#each $videoState.rtspConnections as c (c.id)}
            <div class="rtsp-item" class:active={c.url === $videoState.rtspUrl}>
              {#if editingRtspId === c.id}
                <input
                  class="rtsp-edit rtsp-edit-name"
                  placeholder={$t('video.rtspName')}
                  value={c.name}
                  onchange={(e) => updateRtspConnection(c.id, { name: inputVal(e) })}
                />
                <input
                  class="rtsp-edit"
                  placeholder="rtsp://…"
                  value={c.url}
                  onchange={(e) => updateRtspConnection(c.id, { url: inputVal(e) })}
                />
                <select
                  class="rtsp-transport"
                  value={c.transport}
                  onchange={(e) => updateRtspConnection(c.id, { transport: (e.currentTarget as HTMLSelectElement).value as RtspTransport })}
                >
                  <option value="auto">{$t('video.rtspAuto')}</option>
                  <option value="udp">UDP</option>
                  <option value="tcp">TCP</option>
                </select>
                <button class="rtsp-item-btn" title={$t('video.rtspDone')} aria-label={$t('video.rtspDone')} onclick={() => (editingRtspId = null)}>✓</button>
              {:else}
                <button class="rtsp-item-main" title={c.url} onclick={() => selectRtspConnection(c.id)}>
                  <span class="rtsp-item-name">{c.name || c.url}</span>
                  <span class="rtsp-item-transport">{c.transport === 'auto' ? $t('video.rtspAuto') : c.transport.toUpperCase()}</span>
                </button>
                <button class="rtsp-item-btn" title={$t('video.rtspEdit')} aria-label={$t('video.rtspEdit')} onclick={() => (editingRtspId = c.id)}>✎</button>
                <button class="rtsp-item-btn del" title={$t('video.rtspDelete')} aria-label={$t('video.rtspDelete')} onclick={() => removeRtspConnection(c.id)}>✕</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Opt-in low-CPU path: plays the stream through the WebView's own decoder instead of the
           transcode, at the price of buffering latency. Deliberately a plain, clearly-labelled choice —
           it is a trade, not an improvement. LINUX ONLY: Windows (WebView2) always has WebRTC, so the
           trade never arises there and the toggle would only invite a worse configuration. -->
      {#if isLinux}
        <div class="field-row mse-row">
          <Toggle checked={$videoState.rtspMse} onchange={(c) => setRtspMse(c)} id="vp-rtsp-mse" />
          <span class="label">{$t('video.rtspMse')}</span>
        </div>
        <p class="hint">{$t('video.rtspMseHint')}</p>

        <!-- Width cap for the converted (MJPEG) fallback stream. Only meaningful where that fallback
             exists (Linux WebViews without WebRTC): the transcode is CPU-decoded at BOTH ends, so on a
             small host showing a small window, full source size is paid for nothing. -->
        <label class="field mse-row">
          <span class="label">{$t('video.rtspMaxWidth')}</span>
          <select
            value={String($videoState.rtspMaxWidth)}
            onchange={(e) => setRtspMaxWidth(Number((e.currentTarget as HTMLSelectElement).value))}
          >
            <option value="0">{$t('video.rtspMaxWidthOff')}</option>
            <option value="960">960 px</option>
            <option value="640">640 px</option>
          </select>
        </label>
        <p class="hint">{$t('video.rtspMaxWidthHint')}</p>
      {/if}

      {#if engineChecked && !engineVer}
        <!-- go2rtc is required for any RTSP source. -->
        <div class="ffmpeg-box">
          <p class="hint">{$t('video.engineMissing')}</p>
          {#if engineDownloading}
            <div class="dl-row">
              <div class="dl-bar"><div class="dl-fill" style="width:{enginePct}%"></div></div>
              <span class="dl-pct">{enginePct}%</span>
            </div>
            {#if engineMsg}<p class="hint">{engineMsg}</p>{/if}
          {:else}
            <Button variant="data" onclick={downloadEngine}>{$t('video.engineDownload')}</Button>
            {#if engineMsg}<p class="hint err">{engineMsg}</p>{/if}
          {/if}
        </div>
      {:else if engineVer}
        {#if $videoState.status === 'live' && $videoState.rtspEngine}
          <p class="hint">{$t(`video.via.${$videoState.rtspEngine}`)}</p>
        {:else}
          <p class="hint">{$t('video.engineReady')}</p>
        {/if}

        {#if ffmpegChecked && !ffmpegVer}
          <!-- ffmpeg is the optional fallback reader (e.g. obs-rtspserver). Non-blocking. -->
          <div class="ffmpeg-box">
            <p class="hint">{$t('video.ffmpegFallbackMissing')}</p>
            {#if ffmpegDownloading}
              <div class="dl-row">
                <div class="dl-bar"><div class="dl-fill" style="width:{ffmpegPct}%"></div></div>
                <span class="dl-pct">{ffmpegPct}%</span>
              </div>
              {#if ffmpegMsg}<p class="hint">{ffmpegMsg}</p>{/if}
            {:else}
              <Button variant="standard" onclick={downloadFfmpeg}>{$t('video.ffmpegFallbackDownload')}</Button>
              {#if ffmpegMsg}<p class="hint err">{ffmpegMsg}</p>{/if}
            {/if}
          </div>
        {/if}
      {/if}
    {/if}

    <div class="field-row">
      <Toggle checked={$videoState.mirror} onchange={(c) => setVideoMirror(c)} id="vp-mirror" />
      <span class="label">{$t('video.mirror')}</span>
    </div>
  </div>
{/snippet}

{#snippet footer()}
  <div class="vp-footer">
    <!-- Floating window: a mode button (active = on) — can be toggled off from here. -->
    <Button variant="mode" active={$videoState.floating} onclick={() => toggleFloating()}>
      {$t('video.floatingWindow')}
    </Button>
    <!-- Detached PiP window: a one-way action (can't be closed from inside the app) → plain button.
         PiP is bound to a <video>/MediaStream, so it can't carry an MJPEG (<img>) feed → disabled then. -->
    {#if pipSupported}
      <Button
        variant="standard"
        disabled={$videoState.status !== 'live' || !!$videoState.mjpegUrl}
        onclick={enterPiP}
      >
        {$t('video.videoWindow')}
      </Button>
    {/if}
  </div>
{/snippet}

<div class="vpv2">
  <PanelShell variant="compact" title={$t('video.title')} {headerActions} {body} {footer} />
</div>

<style>
  .vp-body { display: flex; flex-direction: column; gap: 12px; }

  .preview {
    width: 100%;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* will-change: own compositing layer — see VideoWidget: keeps the 60 fps MJPEG <img> from
     dirtying shared layer tiles every frame on WebKitGTK. */
  .preview video { width: 100%; height: 100%; object-fit: contain; display: block; will-change: transform; }
  .preview video.mirror { transform: scaleX(-1); }
  .preview video.hidden { visibility: hidden; }
  .preview img { width: 100%; height: 100%; object-fit: contain; display: block; will-change: transform; }
  .preview img.mirror { transform: scaleX(-1); }
  .preview-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #888;
    font-size: 12px;
    text-align: center;
    padding: 0 10px;
  }
  .info-line {
    font-size: 11px;
    color: #9ad0e8;
    font-variant-numeric: tabular-nums;
    margin-top: -6px;
    letter-spacing: 0.02em;
  }

  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-row { display: flex; align-items: center; gap: 8px; }
  .label { font-size: 12px; color: #aaa; }
  /* Match the framework form-control height (md button = 28px). */
  .field select {
    height: 28px;
    padding: 0 8px;
    background: #434343;
    color: #e0e0e0;
    border: 1px solid #555;
    border-radius: 4px;
    font-size: 12px;
  }
  .field .text-input {
    height: 28px;
    padding: 0 8px;
    background: #434343;
    color: #e0e0e0;
    border: 1px solid #555;
    border-radius: 4px;
    font-size: 12px;
  }
  .hint { font-size: 11px; color: #777; margin: 0; }
  .hint.err { color: #d40000; }

  /* RTSP direct-connect row + saved-connection list */
  .rtsp-url-row { display: flex; align-items: center; gap: 6px; }
  .rtsp-url-row .text-input { flex: 1; min-width: 0; }
  .rtsp-transport {
    height: 28px;
    padding: 0 6px;
    background: #434343;
    color: #e0e0e0;
    border: 1px solid #555;
    border-radius: 4px;
    font-size: 12px;
    flex: 0 0 auto;
  }
  .rtsp-save {
    height: 28px;
    min-width: 30px;
    padding: 0 6px;
    background: #37a8db;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  .rtsp-save:disabled { opacity: 0.4; cursor: not-allowed; }

  .mse-row { margin-top: 4px; }

  .rtsp-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .rtsp-item {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #2e2e2e;
    border: 1px solid #272727;
    border-radius: 4px;
    padding: 3px 4px 3px 6px;
  }
  .rtsp-item.active { border-color: rgba(55, 168, 219, 0.75); }
  .rtsp-item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: none;
    border: none;
    color: #e0e0e0;
    cursor: pointer;
    text-align: left;
    padding: 3px 2px;
    font-size: 12px;
  }
  .rtsp-item-main:hover .rtsp-item-name { color: #37a8db; }
  .rtsp-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rtsp-item-transport { flex: 0 0 auto; font-size: 10px; color: #949494; letter-spacing: 0.04em; }
  .rtsp-item-btn {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    background: none;
    border: none;
    color: #949494;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }
  .rtsp-item-btn:hover { background: #3a3a3a; color: #e0e0e0; }
  .rtsp-item-btn.del:hover { background: rgba(212, 0, 0, 0.3); color: #ff4444; }
  .rtsp-edit {
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 6px;
    background: #434343;
    color: #e0e0e0;
    border: 1px solid #555;
    border-radius: 4px;
    font-size: 12px;
  }
  .rtsp-edit-name { flex: 0 0 90px; }

  .ffmpeg-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
  }
  .dl-row { display: flex; align-items: center; gap: 8px; }
  .dl-bar {
    flex: 1;
    height: 6px;
    background: #1d1d1d;
    border-radius: 3px;
    overflow: hidden;
  }
  .dl-fill { height: 100%; background: #37a8db; transition: width 0.2s ease; }
  .dl-pct { font-size: 11px; color: #9ad0e8; font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }

  .vp-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
</style>
