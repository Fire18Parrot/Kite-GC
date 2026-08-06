// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Serial relay sink — Android build.
//!
//! Same job as `output/serial.rs`, but reached through the USB Host API rather than the `serialport`
//! crate, which has no Android backend. It simply writes through the Android [`SerialConnection`]
//! (`transport/serial_android.rs`), which already owns the JNI shim and the device handle — the Kotlin
//! bridge keys everything by handle, so a relay port and the telemetry link can be open at once.
//!
//! Practical note: this needs a *second* USB device, which on a phone means a powered OTG hub. On a
//! tablet with a single USB-C port the TCP or UDP relay output is usually the workable choice.

use super::OutputSink;
use crate::transport::serial::SerialConnection;
use crate::transport::ByteTransport;

pub struct SerialSink {
    transport: SerialConnection,
}

impl SerialSink {
    pub fn open(port_name: &str, baud_rate: u32) -> Result<Self, String> {
        let transport = SerialConnection::open(port_name, baud_rate)
            .map_err(|e| format!("Failed to open relay port {port_name}: {e}"))?;
        Ok(Self { transport })
    }
}

impl OutputSink for SerialSink {
    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.transport
            .write_bytes(data)
            .map_err(|e| format!("Relay serial write failed: {e}"))
    }

    fn description(&self) -> String {
        self.transport.description()
    }
}
