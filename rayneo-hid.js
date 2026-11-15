/**
 * RayNeo HID Driver for WebXR Extension
 * Handles WebHID communication with RayNeo (TCL) AR glasses.
 *
 * Protocol (community reverse-engineering, verified on an Air 4 Pro; derived from
 * verncat/RayNeo-Air-3S-Pro-OpenVR, Fuut4/rayneo-pin and
 * informalTechCode/RayNeo-Air-Series-3DoF-Scaffold):
 * - Host -> glasses: 64-byte output report, frame[0]=0x66, frame[1]=cmd, frame[2]=value
 * - Glasses -> host: input report, frame[0]=0x99, frame[1]=type
 * - IMU frames (type 0x65), little-endian:
 *     accel  float[3] m/s²   @ offset 4
 *     gyro   float[3] deg/s  @ offset 16
 *     temp   float °C        @ offset 28
 *     tick   uint32 (100 µs) @ offset 40
 *     prox   float           @ offset 44
 * - Commands: 0x01/0x02 IMU on/off, 0x06/0x07 SBS 3D / 2D display, 0x20/0x21 panel 60/120 Hz
 *
 * Device frame: x right, y up, z toward the face (forward = -z) — matches the
 * WebXR viewer frame (x right, y up, -z forward), so the fusion quaternion
 * (device -> world) maps 1:1 onto the WebXR view orientation.
 *
 * IMPORTANT difference from the Viture driver: RayNeo glasses stream raw
 * accelerometer + gyro only (no onboard orientation estimate), so this driver
 * runs a Mahony complementary filter with gyro-bias calibration in JavaScript.
 */

// Debug flag - set to true for verbose logging
const RAYNEO_DEBUG = false;

function debugLog(...args) {
  if (RAYNEO_DEBUG) console.log(...args);
}

// USB identifiers: Air 3S Pro and Air 4 Pro share them (they cannot be
// distinguished by VID/PID alone).
const RAYNEO_VIDS = [0x1bbb, 0x0f65];
const RAYNEO_PID = 0xaf50;

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Minimal quaternion math ({w, x, y, z} objects)
// ---------------------------------------------------------------------------

function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  };
}

function quatConj(q) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function quatNorm(q) {
  const m = Math.hypot(q.w, q.x, q.y, q.z);
  if (m < 1e-12) return { w: 1, x: 0, y: 0, z: 0 };
  return { w: q.w / m, x: q.x / m, y: q.y / m, z: q.z / m };
}

function quatAxisAngle(ax, angle) {
  const s = Math.sin(angle / 2);
  const m = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  return { w: Math.cos(angle / 2), x: ax[0] / m * s, y: ax[1] / m * s, z: ax[2] / m * s };
}

// Rotate vector v by quaternion q (v is an [x, y, z] array)
function quatRotate(q, v) {
  const qv = { w: 0, x: v[0], y: v[1], z: v[2] };
  const t = quatMul(quatMul(q, qv), quatConj(q));
  return [t.x, t.y, t.z];
}

// Quaternion that rotates unit vector a onto unit vector b
function quatFromTo(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 0.999999) return { w: 1, x: 0, y: 0, z: 0 };
  if (d < -0.999999) {
    // 180° about any axis orthogonal to a
    let ax = [1, 0, 0];
    if (Math.abs(a[0]) > 0.9) ax = [0, 1, 0];
    const orth = [
      ax[1] * a[2] - ax[2] * a[1],
      ax[2] * a[0] - ax[0] * a[2],
      ax[0] * a[1] - ax[1] * a[0]
    ];
    return quatAxisAngle(orth, Math.PI);
  }
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  return quatNorm({ w: 1 + d, x: cross[0], y: cross[1], z: cross[2] });
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class RayNeoHID {
  // USB identifiers
  static VENDOR_IDS = RAYNEO_VIDS;
  static PRODUCT_IDS = [RAYNEO_PID];

  static get ALL_DEVICE_IDS() {
    const ids = [];
    for (const vid of RAYNEO_VIDS) ids.push({ vendorId: vid, productId: RAYNEO_PID });
    return ids;
  }

  // Fusion tuning
  static KP = 0.5;                 // Mahony proportional gain
  static CALIB_SAMPLES = 150;      // ~1.3 s of still samples for startup bias calibration
  static CALIB_MAX_GYRO = 3 * DEG; // rad/s per axis allowed during calibration

  constructor() {
    this.device = null;
    this._allDevices = null;
    this.connected = false;
    this.quaternion = { w: 1, x: 0, y: 0, z: 0 }; // pose quaternion (viewer -> world)
    this.callbacks = new Set();

    // Fusion state
    this._initialized = false;
    this._q = { w: 1, x: 0, y: 0, z: 0 }; // device -> world (raw fusion output)
    this._bias = [0, 0, 0];               // gyro bias, rad/s
    this._lastTick = null;
    this._rejectTime = 0;

    // Startup calibration
    this._calCount = 0;
    this._calSum = [0, 0, 0];
    this._calibrated = false;

    // Rest detection (VQF-style) for continuous bias refinement
    this._lpGyro = [0, 0, 0];
    this._lpAcc = [0, 0, 0];
    this._stillTime = 0;

    // Yaw reference for recentering
    this._yawRef = null;

    // IMU stream watchdog
    this._lastReportTime = 0;
    this._watchdog = null;
    this._imuOn = false;
    this._watchWarned = false;
    this._unparsedLogged = 0;
    // Output report IDs to try (0x00 = unnumbered, then common vendor IDs)
    this._outputReportIds = [0x00, 0x66];

    // Diagnostics counters
    this._reportCount = 0;
    this._imuCount = 0;
    this._lastUnparsedHex = '';
  }

  static isSupported() {
    return 'hid' in navigator;
  }

  _matches(device) {
    return RAYNEO_VIDS.includes(device.vendorId) && device.productId === RAYNEO_PID;
  }

  async connect() {
    if (!RayNeoHID.isSupported()) {
      throw new Error('WebHID not supported');
    }

    // Request device (user picks one; both known VID variants are offered)
    const selectedDevices = await navigator.hid.requestDevice({
      filters: RayNeoHID.ALL_DEVICE_IDS
    });

    if (selectedDevices.length === 0) {
      throw new Error('No RayNeo device selected');
    }

    console.log('RayNeo: User selected', selectedDevices.length, 'device(s)');

    // After user authorizes, get ALL authorized RayNeo interfaces
    const allAuthorized = await navigator.hid.getDevices();
    const rayneoDevices = allAuthorized.filter(d => this._matches(d));

    console.log(`RayNeo: Found ${rayneoDevices.length} authorized RayNeo device(s)`);

    // Open and listen on ALL of them (only the vendor/IMU interface will
    // produce 0x99 frames; the others are ignored by the parser)
    for (let i = 0; i < rayneoDevices.length; i++) {
      const device = rayneoDevices[i];
      try {
        if (!device.opened) {
          await device.open();
        }
        device.addEventListener('inputreport', (event) => this._handleInputReport(event, i));
        console.log(`RayNeo: Device ${i + 1} ready (${device.productName})`);
      } catch (e) {
        console.warn(`RayNeo: Failed to open device ${i + 1}:`, e.message);
      }
    }

    this.device = rayneoDevices[0];
    this._allDevices = rayneoDevices;
    this.connected = true;

    await this._startIMU();

    // Notify extension
    window.postMessage({
      type: 'RAYNEO_DEVICE_CONNECTED',
      deviceInfo: this._getDeviceInfo()
    }, '*');

    return this._getDeviceInfo();
  }

  async _sendCommand(cmd, value = 0) {
    const devices = this._allDevices || (this.device ? [this.device] : []);
    const frame = new Uint8Array(64);
    frame[0] = 0x66;
    frame[1] = cmd;
    frame[2] = value;

    for (const device of devices) {
      if (!device.opened) continue;
      let sent = false;
      // Try the documented layout first (report ID 0), then alternatives for
      // hosts/devices that number their reports
      for (const reportId of this._outputReportIds) {
        try {
          await device.sendReport(reportId, frame);
          sent = true;
          if (reportId !== 0x00) {
            console.warn(`RayNeo: command 0x${cmd.toString(16)} needed report ID 0x${reportId.toString(16)} - please report this`);
          }
          break;
        } catch (e) {
          debugLog(`RayNeo: sendReport(id 0x${reportId.toString(16)}, 0x${cmd.toString(16)}) failed:`, e.message);
        }
      }
      if (!sent) {
        console.warn(`RayNeo: could not send command 0x${cmd.toString(16)} to any report ID`);
      }
    }
  }

  async _startIMU() {
    console.log('RayNeo: Sending IMU enable command (0x66 0x01)...');
    this._imuOn = true;
    await this._sendCommand(0x01); // IMU on
    this._lastReportTime = performance.now();

    // Watchdog: the stream stops after the glasses sleep; ask again.
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (!this.connected) return;
      if (performance.now() - this._lastReportTime > 1500) {
        this._sendCommand(0x01);
        if (!this._watchWarned) {
          this._watchWarned = true;
          console.warn('RayNeo: no IMU data received after connecting - re-sending IMU enable. ' +
            'If this keeps appearing, check the "unparsed report" console warnings for the real frame format.');
        }
      }
    }, 2000);
  }

  async checkExistingConnection() {
    if (!RayNeoHID.isSupported()) return false;

    debugLog('RayNeo: Checking for existing connections...');
    const devices = await navigator.hid.getDevices();
    const rayneoDevices = devices.filter(d => this._matches(d));

    if (rayneoDevices.length === 0) {
      debugLog('RayNeo: No matching devices found');
      return false;
    }

    console.log(`RayNeo: Found ${rayneoDevices.length} RayNeo device(s), opening all...`);

    for (let i = 0; i < rayneoDevices.length; i++) {
      const device = rayneoDevices[i];
      try {
        if (!device.opened) {
          await device.open();
        }
        device.addEventListener('inputreport', (event) => this._handleInputReport(event, i));
      } catch (e) {
        console.warn(`RayNeo: Failed to open device ${i + 1}:`, e.message);
      }
    }

    this.device = rayneoDevices[0];
    this._allDevices = rayneoDevices;
    this.connected = true;

    await this._startIMU();

    window.postMessage({
      type: 'RAYNEO_DEVICE_CONNECTED',
      deviceInfo: this._getDeviceInfo()
    }, '*');

    return true;
  }

  async disconnect() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
    if (this._allDevices) {
      try {
        await this._sendCommand(0x02); // IMU off
      } catch (e) { /* ignore */ }
      for (const device of this._allDevices) {
        if (device && device.opened) {
          try {
            await device.close();
          } catch (e) {
            console.warn('RayNeo: Error closing device:', e);
          }
        }
      }
    }
    this.device = null;
    this._allDevices = null;
    this.connected = false;
    this._imuOn = false;

    window.postMessage({ type: 'RAYNEO_DEVICE_DISCONNECTED' }, '*');
  }

  // Display helpers ----------------------------------------------------------

  /** Put the glasses in 3840x1080 side-by-side mode (needed for stereo WebXR
   *  content to appear correctly). Pass false to switch back to 2D. */
  async setStereo(on) {
    await this._sendCommand(on ? 0x06 : 0x07);
  }

  /** Panel refresh rate: 60 or 120 Hz. */
  async setPanelRate(rate) {
    await this._sendCommand(rate >= 120 ? 0x21 : 0x20);
  }

  // Input report handling ----------------------------------------------------

  _handleInputReport(event, deviceIndex = 0) {
    const dv = event.data;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this._lastReportTime = performance.now();
    this._reportCount++;

    if (bytes.length < 48) return;

    // Locate the 0x99 frame header. Hosts and firmwares disagree about
    // whether it lives in the report ID or the data, so try all layouts:
    //   a) data[0]=0x99, data[1]=type            (header in data)
    //   b) data[1]=0x99, data[2]=type            (padded)
    //   c) reportId=0x99, data[0]=type           (header consumed as report ID)
    // Payload offsets are relative to the header (accel = header+4).
    let hdrIdx = -99;
    if (bytes[0] === 0x99) hdrIdx = 0;
    else if (bytes[1] === 0x99) hdrIdx = 1;
    else if (event.reportId === 0x99 && bytes[0] === 0x65) hdrIdx = -1;

    if (hdrIdx > -99) {
      const type = hdrIdx >= 0 ? bytes[hdrIdx + 1] : bytes[0];
      if (type === 0x65) {
        this._handleImuFrame(dv, hdrIdx + 4);
      } else if (type === 0xc8) {
        this._handleAck(bytes, hdrIdx);
      }
      return;
    }

    // Unrecognized frame: log the first few so we can identify the real format
    this._unparsedLogged++;
    const hex = Array.from(bytes.slice(0, 24)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    this._lastUnparsedHex = `reportId 0x${event.reportId.toString(16)}: ${hex}`;
    if (this._unparsedLogged <= 10) {
      console.warn(`RayNeo: unparsed report (device ${deviceIndex}, ${this._lastUnparsedHex})`);
    }
  }

  _handleImuFrame(dv, base) {
    // base = offset of the accelerometer float[3] (header+4 per protocol)
    this._imuCount++;
    if (this._imuCount === 1) {
      console.log('RayNeo: IMU stream started - gyro bias calibration begins, hold still ~1.5 s');
    }
    const acc = [dv.getFloat32(base, true), dv.getFloat32(base + 4, true), dv.getFloat32(base + 8, true)];
    const gyroDeg = [dv.getFloat32(base + 12, true), dv.getFloat32(base + 16, true), dv.getFloat32(base + 20, true)];
    const temperature = dv.getFloat32(base + 24, true);
    const tick = dv.getUint32(base + 36, true);

    this._lastReportTime = performance.now();

    const gyro = gyroDeg.map(g => g * DEG); // deg/s -> rad/s
    this._fuse(acc, gyro, tick);

    if (!this._logCount) this._logCount = 0;
    this._logCount++;
    if (RAYNEO_DEBUG && (this._logCount <= 5 || this._logCount % 500 === 0)) {
      console.log('RayNeo IMU: acc', acc.map(v => v.toFixed(2)), 'gyro°/s', gyroDeg.map(v => v.toFixed(2)),
        'temp', temperature.toFixed(1), 'q', this.quaternion);
    }
  }

  _handleAck(bytes, off) {
    // Ack frames; byte off+8 carries sleep (0x41) / wake (0x42) notices on
    // some firmware. On wake, restart the IMU stream.
    const b = bytes[off + 8];
    if (b === 0x42 && !this._imuOn) {
      debugLog('RayNeo: glasses woke up, restarting IMU');
      this._imuOn = true;
      this._sendCommand(0x01);
    } else if (b === 0x41) {
      this._imuOn = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Fusion: Mahony complementary filter + gyro-bias calibration
  // ---------------------------------------------------------------------------

  _fuse(acc, gyro, tick) {
    if (!this._initialized) {
      const an = Math.hypot(acc[0], acc[1], acc[2]);
      if (an < 1) return;
      // Initialize orientation from gravity: map measured "up" onto world +y
      this._q = quatFromTo([acc[0] / an, acc[1] / an, acc[2] / an], [0, 1, 0]);
      this._initialized = true;
      this._lastTick = tick;
      this._lpAcc = [...acc];
      this._lpGyro = [...gyro];
      return;
    }

    if (tick === this._lastTick) return; // glasses re-send the last sample when idle
    const dt = ((tick - this._lastTick) >>> 0) * 1e-4;
    this._lastTick = tick;
    if (dt <= 0 || dt > 0.05) return; // bad/first dt after a stall

    // --- Startup bias calibration: mean of still samples --------------------
    if (!this._calibrated) {
      const moving = Math.max(Math.abs(gyro[0]), Math.abs(gyro[1]), Math.abs(gyro[2])) > RayNeoHID.CALIB_MAX_GYRO;
      if (moving) {
        this._calCount = 0;
        this._calSum = [0, 0, 0];
      } else {
        for (let i = 0; i < 3; i++) this._calSum[i] += gyro[i];
        this._calCount++;
        if (this._calCount >= RayNeoHID.CALIB_SAMPLES) {
          this._bias = this._calSum.map(s => s / this._calCount);
          this._calibrated = true;
          console.log('RayNeo: gyro bias calibrated', this._bias.map(b => (b / DEG).toFixed(3) + '°/s'));
          this.recenter(); // define "forward" once we're stable
        }
      }
    }

    // --- Low-pass for rest detection (VQF-style) -----------------------------
    const k = Math.min(dt / 0.5, 1);
    for (let i = 0; i < 3; i++) {
      this._lpGyro[i] += (gyro[i] - this._lpGyro[i]) * k;
      this._lpAcc[i] += (acc[i] - this._lpAcc[i]) * k;
    }

    // At rest: gyro matches its own low-pass, the low-passed gyro is close to
    // the current bias, and the accelerometer is steady. Then the low-passed
    // gyro IS the bias (drift correction).
    const gyroJitter = Math.hypot(gyro[0] - this._lpGyro[0], gyro[1] - this._lpGyro[1], gyro[2] - this._lpGyro[2]);
    const accJitter = Math.hypot(acc[0] - this._lpAcc[0], acc[1] - this._lpAcc[1], acc[2] - this._lpAcc[2]);
    let corrMax = 0;
    for (let i = 0; i < 3; i++) corrMax = Math.max(corrMax, Math.abs(this._lpGyro[i] - this._bias[i]));
    const resting = gyroJitter < 2 * DEG && corrMax < 0.6 * DEG && accJitter < 0.5;

    this._stillTime = resting ? this._stillTime + dt : 0;
    if (this._stillTime > 1.5) {
      const kb = Math.min(dt / 3, 1);
      for (let i = 0; i < 3; i++) this._bias[i] += (this._lpGyro[i] - this._bias[i]) * kb;
    }

    // --- Mahony correction ---------------------------------------------------
    const w = [gyro[0] - this._bias[0], gyro[1] - this._bias[1], gyro[2] - this._bias[2]];
    let wc = [w[0], w[1], w[2]];
    const an = Math.hypot(acc[0], acc[1], acc[2]);

    if (an > 7 && an < 12.5) {
      const measuredUp = [acc[0] / an, acc[1] / an, acc[2] / an];
      const estimatedUp = quatRotate(quatConj(this._q), [0, 1, 0]); // world up in device frame
      const err = [
        measuredUp[1] * estimatedUp[2] - measuredUp[2] * estimatedUp[1],
        measuredUp[2] * estimatedUp[0] - measuredUp[0] * estimatedUp[2],
        measuredUp[0] * estimatedUp[1] - measuredUp[1] * estimatedUp[0]
      ];
      const errMag = Math.hypot(err[0], err[1], err[2]);
      const errAngle = Math.asin(Math.min(1, errMag));

      let accept = (Math.abs(an - 9.81) < 1.5 && errAngle < 10 * DEG) || this._rejectTime > 3;
      let gain = RayNeoHID.KP / (1 + Math.hypot(w[0], w[1], w[2]) / 2);

      if (accept) {
        // After a long rejection, converge fast once (x-io Fusion style)
        if (this._rejectTime > 3) gain *= 5;
        this._rejectTime = 0;
        wc = [wc[0] + gain * err[0], wc[1] + gain * err[1], wc[2] + gain * err[2]];
      } else {
        // Fast head turns leak centripetal acceleration into the reading
        this._rejectTime += dt;
      }
    }

    // Integrate: q = q * quat(wc * dt)   (body-frame angular velocity)
    const wMag = Math.hypot(wc[0], wc[1], wc[2]);
    const angle = wMag * dt;
    if (angle > 1e-12) {
      this._q = quatNorm(quatMul(this._q, quatAxisAngle(wc, angle)));
    }

    // --- Pose with yaw-only recentering --------------------------------------
    if (this._yawRef) {
      this.quaternion = quatNorm(quatMul(quatConj(this._yawRef), this._q));
    } else {
      this.quaternion = this._q;
    }

    this._notifyCallbacks();
  }

  recenter() {
    // Reset yaw to the current facing direction; keep pitch and roll absolute.
    const f = quatRotate(this._q, [0, 0, -1]); // forward in world frame
    const yaw = Math.atan2(-f[0], -f[2]);
    this._yawRef = quatAxisAngle([0, 1, 0], yaw);
    if (this._initialized) {
      this.quaternion = quatNorm(quatMul(quatConj(this._yawRef), this._q));
    }
  }

  _getDeviceInfo() {
    if (!this.device) return null;
    return {
      model: `RayNeo Air (${(this.device.productName || 'AR glasses')})`,
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      productName: this.device.productName
    };
  }

  onOrientationChange(callback) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  _notifyCallbacks() {
    const q = this.quaternion;
    this.callbacks.forEach(cb => cb(q));

    // Also notify extension for cross-tab sync
    window.postMessage({
      type: 'RAYNEO_ORIENTATION_UPDATE',
      orientation: q
    }, '*');
  }

  getQuaternion() {
    return { ...this.quaternion };
  }

  getQuaternionArray() {
    return [this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w];
  }

  /** Snapshot of the connection/stream state for debugging */
  getDiagnostics() {
    return {
      connected: this.connected,
      reportsReceived: this._reportCount,
      imuFramesParsed: this._imuCount,
      fusionInitialized: this._initialized,
      biasCalibrated: this._calibrated,
      lastUnparsedReport: this._lastUnparsedHex,
      quaternion: this.quaternion
    };
  }
}

// Make available globally in page context
window.RayNeoHID = RayNeoHID;
