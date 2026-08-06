// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Marc Hoffmann (b14ckyy)

//! Serial transport — **Android stand-in** for `transport/serial.rs`.
//!
//! Android has no `/dev/tty*` an unprivileged app may open, so the `serialport` crate (which the
//! desktop implementation is built on) has no backend there and is not even compiled into the mobile
//! build — see the `cfg(not(target_os = "android"))` dependency block in `Cargo.toml`.
//!
//! A USB-serial link on Android goes through the **USB Host API**: the app receives permission for a
//! specific `UsbDevice`, opens a `UsbDeviceConnection`, and drives the CDC-ACM / FTDI / CP210x
//! endpoints itself from Kotlin. That is a Tauri mobile plugin, not a change to this file — until it
//! exists, this module keeps the shared `ByteTransport` surface intact so every caller
//! (`commands/connection.rs`, the ADS-B and formation-flight radar sources) compiles and links on
//! Android, and reports one clear reason instead of a missing symbol.
//!
//! The UI reflects this the same way it reflects an empty port list on desktop: `list_ports()`
//! returns nothing, so the serial option shows no devices to pick.

use std::time::Duration;

use super::{ByteTransport, PortInfo, TransportError};

/// The single message the frontend and the log get for any serial attempt on Android.
const UNSUPPORTED: &str =
    "Serial ports are not available on Android — connect over UDP or TCP instead \
     (USB-serial needs the Android USB Host API, which is not implemented yet)";

/// Always empty on Android: there is no enumerable serial device without the USB Host API.
/// Callers treat this exactly like a desktop machine with nothing plugged in.
pub fn list_ports() -> Vec<PortInfo> {
    Vec::new()
}

/// Placeholder mirroring the desktop `SerialConnection` so the type exists on Android. It can never
/// be constructed — `open()` is the only constructor and it always fails — so the `ByteTransport`
/// methods below are unreachable and simply report a disconnected link.
pub struct SerialConnection {
    /// Uninhabited, which is what makes "cannot be constructed" a compile-time fact rather than a
    /// convention: there is no value of this type, so no code path can produce a `SerialConnection`.
    _never: std::convert::Infallible,
}

impl SerialConnection {
    pub fn open(port_name: &str, baud_rate: u32) -> Result<Self, String> {
        log::warn!("Serial open refused on Android: {port_name} @ {baud_rate} baud — {UNSUPPORTED}");
        Err(UNSUPPORTED.to_string())
    }

    pub fn set_control_signals(&mut self, _dtr: bool, _rts: bool) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}

impl ByteTransport for SerialConnection {
    fn read_bytes(&mut self, _buf: &mut [u8]) -> Result<usize, TransportError> {
        Err(TransportError::Disconnected)
    }

    fn write_bytes(&mut self, _data: &[u8]) -> Result<(), TransportError> {
        Err(TransportError::Disconnected)
    }

    fn set_read_timeout(&mut self, _timeout: Duration) {}

    fn description(&self) -> String {
        "Serial(unavailable on Android)".to_string()
    }
}
