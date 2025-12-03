package io.github.encento.dzengunste

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bleManager: BleManager

    // ---- permissions ----
    private val neededPermissions = mutableListOf(
        Manifest.permission.ACCESS_FINE_LOCATION
    ).apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_SCAN)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
    }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            val granted = result.values.all { it }
            if (granted) {
                Toast.makeText(this, "BLE разрешения выданы", Toast.LENGTH_SHORT).show()
                evalJs("window.dzlog && window.dzlog('BLE permissions granted');")
            } else {
                Toast.makeText(this, "BLE разрешения отклонены", Toast.LENGTH_LONG).show()
            }
        }

    // ---- lifecycle ----
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        bleManager = BleManager(this)

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = true
            allowContentAccess = true
            defaultTextEncodingName = "utf-8"
        }

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()
        webView.addJavascriptInterface(AndroidBridge(), "Android")

        // ТВОЙ index.html из assets/web
        webView.loadUrl("file:///android_asset/web/index.html")

        requestBlePermissions()
    }

    // ---- JS bridge ----
    inner class AndroidBridge {

        @JavascriptInterface
        fun isSupported(): Boolean {
            return bleManager.isSupported()
        }

        @JavascriptInterface
        fun connect() {
            runOnUiThread { openDevicePicker() }
        }

        @JavascriptInterface
        fun disconnect() {
            runOnUiThread { bleManager.disconnect() }
        }

        @JavascriptInterface
        fun send(data: String) {
            runOnUiThread { bleManager.send(data) }
        }

        @JavascriptInterface
        fun startScan() {
            runOnUiThread { openDevicePicker() }
        }
    }

    // ---- Device picker ----
    private fun openDevicePicker() {
        if (!bleManager.isSupported()) {
            Toast.makeText(this, "BLE не поддерживается", Toast.LENGTH_SHORT).show()
            return
        }

        val adapter = BluetoothAdapter.getDefaultAdapter()
        if (adapter?.isEnabled != true) {
            Toast.makeText(this, "Включи Bluetooth", Toast.LENGTH_SHORT).show()
            return
        }

        val devices = mutableListOf<BluetoothDevice>()

        bleManager.startScan { device ->
            if (!devices.contains(device)) devices.add(device)
        }

        Handler(Looper.getMainLooper()).postDelayed({
            showDeviceDialog(devices)
        }, 8000)
    }

    private fun showDeviceDialog(devices: List<BluetoothDevice>) {
        if (devices.isEmpty()) {
            Toast.makeText(this, "Устройства не найдены", Toast.LENGTH_SHORT).show()
            return
        }

        val names = devices.map { "${it.name ?: "Без имени"} (${it.address})" }.toTypedArray()


    }

    // ---- permissions ----
    private fun requestBlePermissions() {
        val missing = neededPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            permissionLauncher.launch(neededPermissions)
        }
    }

    // ---- helper для JS ----
    private fun evalJs(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }
}
