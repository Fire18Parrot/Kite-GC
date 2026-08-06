package com.kitegc.app

import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  /** Timestamp of the last back press, for the confirm-to-exit guard below. 0 = none pending. */
  private var lastBackPress = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    // Before super.onCreate, which is what starts Tauri and therefore the Rust side: the USB-serial
    // bridge has no Context of its own and the first port enumeration can arrive as soon as the
    // frontend is up.
    UsbSerial.init(this)

    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Keep the display awake while the GCS is in the foreground. A ground station is watched, not
    // interacted with — minutes can pass between touches during a mission — and the screen blanking
    // mid-flight is exactly when the telemetry matters most. FLAG_KEEP_SCREEN_ON is scoped to this
    // window and released automatically when the app leaves the foreground, so it needs no WAKE_LOCK
    // permission and cannot keep the device awake in the background.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // Require a deliberate double-press to leave. The default back behaviour finishes the activity
    // immediately, which on a gesture-navigation device means an edge swipe — easy to trigger by
    // accident while panning the map — tears down the telemetry link with no confirmation.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val now = System.currentTimeMillis()
        if (now - lastBackPress < BACK_TO_EXIT_WINDOW_MS) {
          finish()
        } else {
          lastBackPress = now
          Toast.makeText(this@MainActivity, R.string.back_to_exit, Toast.LENGTH_SHORT).show()
        }
      }
    })
  }

  private companion object {
    /** How long the first back press stays "armed". Long enough to read the toast, short enough that
     *  a press minutes later is not treated as a confirmation. */
    const val BACK_TO_EXIT_WINDOW_MS = 2000L
  }
}
