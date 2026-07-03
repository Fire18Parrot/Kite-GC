// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Backend map-tile loader.
//!
//! Fetches map tiles through the Rust HTTP stack (reqwest → HTTP/2 + connection
//! pooling) instead of the OS WebView's HTTP client, for both the 2D (Leaflet)
//! and 3D (Cesium) tile pipelines. The WebView caps connections per host and, on
//! WebKitGTK/Linux, serialises requests to a single-host provider (e.g. ESRI),
//! which makes tiles crawl in; reqwest multiplexes over HTTP/2 without that cap,
//! so tile loading is fast and consistent across all platforms. A concurrency
//! gate keeps us a polite client toward community providers (see below).

use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Semaphore;

/// Cap on concurrent tile fetches. Bypassing the WebView removes the browser's
/// natural per-host connection limit, so a single pan could otherwise fire 100+
/// requests at once — fine for CDN providers (ESRI/Carto) but a policy/ban risk
/// for community servers (OSM, OpenTopoMap). 12 in flight keeps loading fast
/// (parallel HTTP/2 over pooled connections) while staying a polite client.
/// Easily tuned; a future refinement could vary it per provider.
const MAX_CONCURRENT_TILE_FETCHES: usize = 12;

/// Shared HTTP client — pooled connections + HTTP/2, reused across all tile fetches.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("KiteGroundControl/1.0 (+https://github.com/b14ckyy/Kite-GC)")
            .timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build tile HTTP client")
    })
}

/// Global gate bounding how many tile fetches run at once (see the const above).
fn fetch_gate() -> &'static Semaphore {
    static GATE: OnceLock<Semaphore> = OnceLock::new();
    GATE.get_or_init(|| Semaphore::new(MAX_CONCURRENT_TILE_FETCHES))
}

/// Fetch a single map tile and return its raw bytes to the frontend.
///
/// Returned as a Tauri `Response` so the bytes travel over IPC as a real binary
/// payload (an `ArrayBuffer` on the JS side), not a JSON number array.
#[tauri::command]
pub async fn fetch_tile(url: String) -> Result<tauri::ipc::Response, String> {
    // Hold a permit for the whole request so no more than MAX_CONCURRENT_TILE_FETCHES
    // are ever in flight; excess fetches queue here and proceed as permits free up.
    let _permit = fetch_gate()
        .acquire()
        .await
        .map_err(|e| format!("tile gate closed: {e}"))?;
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("tile request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("tile HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("tile body read failed: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}
