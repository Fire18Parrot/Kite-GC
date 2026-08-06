// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! BLE relay sink — **Android stand-in** for `output/ble.rs`.
//!
//! The sink is built on `transport::ble::connect_ble`, which has no Android implementation yet (see
//! `transport/ble_android.rs`). Use the UDP or TCP relay output instead.

use super::OutputSink;

pub struct BleSink {
    _never: std::convert::Infallible,
}

impl BleSink {
    pub async fn open(device_id: &str) -> Result<Self, String> {
        log::warn!("Relay BLE sink refused on Android ({device_id})");
        Err("BLE relay output is not available on Android — use the UDP or TCP relay instead"
            .to_string())
    }
}

impl OutputSink for BleSink {
    fn write(&mut self, _data: &[u8]) -> Result<(), String> {
        Err("BLE relay output is not available on Android".to_string())
    }

    fn description(&self) -> String {
        "BLE(unavailable on Android)".to_string()
    }
}
