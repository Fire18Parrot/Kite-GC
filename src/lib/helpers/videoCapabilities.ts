// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

// Native-capture capability logic (pure). The backend `video_probe_device` returns raw device modes;
// we intersect them with a curated FPV catalog so the picker stays short (resolution → framerate),
// instead of dumping the device's full cross-product. Every catalog row is offered only if the device
// reports it — uniform rule, no special cases. See docs (VIDEO_NATIVE_CAPTURE.md).
//
// Codec/pixel-format is NOT a user control: the primary render path is getUserMedia (a hardware
// `<video>` — the only surface that doesn't contend with the map compositor), and getUserMedia picks
// the codec itself to satisfy the requested resolution/fps. So the cascade aggregates across all of a
// device's codecs; `modes[].codec` is retained only to compute fps ranges.

/** One capture mode reported by the backend probe. Resolutions are a range (min..max); discrete
 *  devices report min === max. `fpsMax <= 0` means the framerate is unknown (V4L2 reports none). */
export interface CaptureMode {
  codec: string;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  fpsMin: number;
  fpsMax: number;
}

/** A device discovered by the backend enumeration. */
export interface NativeDevice {
  id: string;
  name: string;
}

/** The user's chosen native-capture configuration. */
export interface NativeSelection {
  width: number;
  height: number;
  fps: number;
}

interface CatalogEntry {
  width: number;
  height: number;
  /** Friendly label, e.g. "1920×1080 (1080p)". */
  label: string;
  /** Curated framerates sensible for this class (filtered against the device's reported range). */
  fps: number[];
}

// Curated FPV catalog. Nothing above 1440p (no FPV system streams higher meaningfully). Analog PAL/
// NTSC carry their standard field-doubled rates; digital modes use 30/60.
export const FPV_CATALOG: readonly CatalogEntry[] = [
  { width: 720, height: 576, label: '720×576 (PAL)', fps: [25, 50] },
  { width: 720, height: 480, label: '720×480 (NTSC)', fps: [30, 60] },
  { width: 640, height: 480, label: '640×480 (VGA 4:3)', fps: [30, 60] },
  { width: 1280, height: 720, label: '1280×720 (720p)', fps: [30, 60] },
  { width: 1920, height: 1080, label: '1920×1080 (1080p)', fps: [30, 60] },
  { width: 2560, height: 1440, label: '2560×1440 (1440p)', fps: [30, 60] },
] as const;

/** Does a mode's resolution range cover `w×h`? */
function covers(m: CaptureMode, w: number, h: number): boolean {
  return w >= m.minWidth && w <= m.maxWidth && h >= m.minHeight && h <= m.maxHeight;
}

/** Catalog resolutions the device supports (covered by any mode). Empty probe → the full catalog (we
 *  can't verify, so offer the sensible set and let getUserMedia negotiate). */
export function resolutionsFor(modes: CaptureMode[]): CatalogEntry[] {
  if (modes.length === 0) return [...FPV_CATALOG];
  return FPV_CATALOG.filter((c) => modes.some((m) => covers(m, c.width, c.height)));
}

/** Framerates offered at `w×h`: curated values inside the device's reported range (unioned across all
 *  codecs). Unknown range (V4L2) → all curated values. Fallback: if none of the curated values fit,
 *  offer the device's reported max so an otherwise-usable mode isn't hidden. */
export function frameratesFor(modes: CaptureMode[], w: number, h: number): number[] {
  const entry = FPV_CATALOG.find((c) => c.width === w && c.height === h);
  const curated = entry ? entry.fps : [30, 60];
  if (modes.length === 0) return curated;

  const covering = modes.filter((m) => covers(m, w, h));
  if (covering.length === 0) return curated;
  if (covering.every((m) => m.fpsMax <= 0)) return curated;

  const lo = Math.min(...covering.filter((m) => m.fpsMin > 0).map((m) => m.fpsMin), Infinity);
  const hi = Math.max(...covering.map((m) => m.fpsMax), 0);
  const inRange = curated.filter((f) => (lo === Infinity || f >= lo) && f <= hi);
  if (inRange.length > 0) return inRange;

  return hi > 0 ? [Math.round(hi)] : curated;
}

/** Smart default: the highest resolution that still yields ≥30 fps; and 30 fps if available, else the
 *  highest offered. */
export function defaultSelection(modes: CaptureMode[]): NativeSelection {
  const resolutions = resolutionsFor(modes);
  const sorted = [...resolutions].sort((a, b) => b.width * b.height - a.width * a.height);
  const pick =
    sorted.find((c) => frameratesFor(modes, c.width, c.height).some((f) => f >= 30)) ?? sorted[0];
  if (!pick) return { width: 1280, height: 720, fps: 30 };
  const fps = frameratesFor(modes, pick.width, pick.height);
  return { width: pick.width, height: pick.height, fps: fps.includes(30) ? 30 : (fps[fps.length - 1] ?? 30) };
}

/** Re-validate a selection against the available modes, correcting any field that no longer fits
 *  (cascade repair after a device/resolution change). */
export function validateSelection(modes: CaptureMode[], sel: NativeSelection): NativeSelection {
  const resolutions = resolutionsFor(modes);
  let { width, height } = sel;
  if (!resolutions.some((c) => c.width === width && c.height === height)) {
    const top = [...resolutions].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!top) return defaultSelection(modes);
    width = top.width;
    height = top.height;
  }
  const fps = frameratesFor(modes, width, height);
  const chosenFps = fps.includes(sel.fps) ? sel.fps : fps.includes(30) ? 30 : (fps[fps.length - 1] ?? 30);
  return { width, height, fps: chosenFps };
}

/** Friendly label for a resolution (falls back to raw `W×H` if it isn't in the catalog). */
export function resolutionLabel(width: number, height: number): string {
  return FPV_CATALOG.find((c) => c.width === width && c.height === height)?.label ?? `${width}×${height}`;
}
