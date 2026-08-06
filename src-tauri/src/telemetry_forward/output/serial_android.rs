// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Serial relay sink — **Android stand-in** for `output/serial.rs`.
//!
//! Same reason as `transport/serial_android.rs`: the `serialport` crate has no Android backend and is
//! not in the mobile dependency set. The relay's TCP and UDP sinks are unaffected and remain the way
//! to feed an antenna tracker or a second GCS from Android.

use super::OutputSink;

pub struct SerialSink {
    _never: std::convert::Infallible,
}

impl SerialSink {
    pub fn open(port_name: &str, baud_rate: u32) -> Result<Self, String> {
        log::warn!("Relay serial sink refused on Android: {port_name} @ {baud_rate} baud");
        Err("Serial relay output is not available on Android — use the UDP or TCP relay instead"
            .to_string())
    }
}

impl OutputSink for SerialSink {
    fn write(&mut self, _data: &[u8]) -> Result<(), String> {
        Err("Serial relay output is not available on Android".to_string())
    }

    fn description(&self) -> String {
        "Serial(unavailable on Android)".to_string()
    }
}
