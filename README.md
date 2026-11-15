# RayNeo WebXR Extension

A Chrome extension that enables WebXR head-tracking support for **RayNeo (TCL) AR glasses** on any website that supports WebXR.

This is a port of [bfvogel/viture-webxr-extension](https://github.com/bfvogel/viture-webxr-extension) — the WebXR polyfill, injection plumbing and popup are the original architecture; only the HID driver was rewritten for RayNeo.

## What it does

- **WebXR everywhere** — presents the glasses as a standard WebXR `immersive-vr` device, so any WebXR-enabled site (three.js/A-Frame demos, DeoVR, …) renders in the glasses with head tracking
- **YouTube head tracking** — a glasses icon in the YouTube player feeds your head rotation to YouTube's own VR renderer (works on 360° and VR180 videos)
- **Display control** — switches the glasses between 2D and SBS 3D modes, and 60/120 Hz panel refresh
- Works under strict CSP sites (the tracking script runs as a MAIN-world content script)

## Supported devices

- RayNeo Air 4 Pro (verified against community protocol research)
- RayNeo Air 3S Pro / Air 3s (same USB identity `1BBB:AF50` — likely works, untested)

## Requirements

- Chrome, Edge, or Opera browser (WebHID support required)
- RayNeo glasses connected via USB-C

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" in the top right corner
3. Click "Load unpacked"
4. Select the `rayneo-webxr-extension` folder
5. The extension icon should appear in your toolbar

## Usage

1. Connect your RayNeo glasses to your computer via USB-C
2. Open any website (WebHID needs an http(s) page context)
3. Click the RayNeo WebXR extension icon in your browser toolbar
4. Click "Connect RayNeo Glasses"
5. A permission dialog will appear — select the RayNeo device
6. Keep your head still for ~1.5 s while the gyro bias calibrates
7. Visit a WebXR-enabled site and start an immersive session

### Recentering

Click "Recenter View" in the extension popup to reset the yaw center of your view (pitch/roll stay absolute). Recentering also happens automatically once bias calibration finishes.

### Console commands

For debugging, available in the page console after connection:

```js
// Manually connect
window.connectRayNeo()

// Recenter the view
window.recenterRayNeo()

// Current orientation quaternion
window.RayNeoWebXR.getRayNeo().getQuaternion()

// Switch the glasses display between SBS 3D and 2D
window.RayNeoWebXR.getRayNeo().setStereo(true)
window.RayNeoWebXR.getRayNeo().setStereo(false)

// Panel refresh rate (60 or 120 Hz)
window.RayNeoWebXR.getRayNeo().setPanelRate(120)
```

## Watching VR/360° video (YouTube, etc.)

The polyfill is injected into **every** http(s) page automatically — including sites with a strict Content-Security-Policy like YouTube (it runs as a MAIN-world content script, which page CSP cannot block).

### YouTube — head tracking mode

YouTube's web player has its own VR renderer (the one used by the pan-around view and mobile Cardboard mode). Rather than replacing it, the extension simply feeds it your head rotation every frame via the player API (`movie_player.setSphericalProperties({yaw, pitch})`). This works on any VR video — 360° and VR180, mono or stereo — and requires no custom WebGL.

1. Open a VR/360° video on YouTube
2. Connect the glasses (popup → "Connect RayNeo Glasses")
3. Click the **glasses icon** in the player's right-side controls — it turns orange while tracking is active. Alternatives: the popup's "YouTube tracking" button, or in the page console:
   ```js
   __rayneoYouTubeTracking()   // toggle on/off
   ```
4. Turn your head — the view follows

While tracking is active:

- **R** — recenter the view to where you're facing
- **Esc** — stop tracking
- If a video pans the wrong way, `__rayneoYouTubeFlip()` (yaw) and `__rayneoYouTubeFlipPitch()` (pitch) invert each axis; both settings persist per-site

Notes:

- YouTube's own VR/goggles toolbar button is unreliable on desktop (a known YouTube bug), so the extension does not depend on it.
- Tracking is yaw/pitch only — roll is deliberately ignored so the horizon stays level (the IMU is 3DoF and yaw drifts slowly; recenter with R when needed).
- The video image itself is rendered by YouTube: a mono VR180 video looks mono because the *content* is mono, not because of the extension. The container's `StereoMode` element decides mono vs stereo per video.
- For debugging: `__rayneoYouTubeVRInfo()` shows whether the current video is a VR projection.

### DeoVR and other WebXR players

The polyfill presents the glasses as a standard WebXR device, so any site using **WebXR `immersive-vr`** sessions can go full-immersive — WebXR samples, A-Frame and Three.js demos (verified), and DeoVR's web player. Not supported: WebVR 1.1-only sites, plain `deviceorientation`-based viewers, or 6DoF/controller experiences.

On deovr.com the extension rewrites the User-Agent so the site offers its VR mode, and the popup's "Enter VR (player)" button dispatches the player's internal Enter-VR event (`MU.events.emit(177)`) as a fallback, since the site's own button may not respond.

Note: connect the glasses on the tab you'll watch in — WebHID permission prompts are per-tab, and the popup routes the connect request to the active page.

## How it works

The extension creates a WebXR polyfill that:

1. Intercepts `navigator.xr` calls
2. Connects to the glasses via WebHID
3. Reads the raw IMU stream and fuses it into an orientation quaternion
4. Provides the tracking data to WebXR sessions

The glasses appear as a standard WebXR device to websites, enabling head tracking on any site that supports WebXR without requiring native RayNeo support.

## Differences from the Viture original

**Viture glasses send finished Euler angles over USB** — the original driver just parses and passes them through. **RayNeo glasses only stream raw accelerometer + gyro data**, so this driver runs a sensor-fusion pipeline in JavaScript:

1. **Startup bias calibration** — ~1.5 s of still samples estimate the gyro bias
2. **Rest detection (VQF-style)** — whenever you're still, the low-passed gyro continuously refines the bias, which compensates thermal drift as the glasses warm up
3. **Mahony complementary filter** — gyro integration, gravity-corrected by the accelerometer with gating (rejected while accelerating or during fast turns), fast re-convergence after long rejections
4. **Yaw-only recentering** — standard 3DoF XR behavior

Tradeoff: RayNeo has no magnetometer, so **yaw slowly drifts** between recenters (the bias refinement keeps it small, but it's physics, not a bug). This is why Recenter exists.

## Technical details

### USB identifiers

- Vendor IDs: `0x1bbb` (also `0x0f65` in the wild)
- Product ID: `0xaf50` (Air 3S Pro and Air 4 Pro share it and cannot be distinguished by VID/PID)

### Protocol

Vendor HID, 64-byte reports. Host → glasses frames start with `0x66 <cmd> <value>`; glasses → host frames start with `0x99 <type>`. IMU frames (type `0x65`, little-endian):

| Offset | Field |
|---|---|
| 4 | Accelerometer, `float[3]`, m/s² |
| 16 | Gyro, `float[3]`, °/s |
| 28 | Temperature, °C |
| 40 | Tick, `uint32`, 100 µs units (~118 Hz stream) |
| 44 | Proximity |

Commands used: `0x01`/`0x02` IMU on/off, `0x06`/`0x07` SBS 3D / 2D display, `0x20`/`0x21` panel 60/120 Hz.

Device frame: x right, y up, z toward the face — matching the WebXR viewer frame (x right, y up, −z forward), so the fusion quaternion maps 1:1 onto the view orientation.

### Files

- `manifest.json` — extension configuration
- `background.js` — service worker for state management
- `content-script.js` — popup ↔ page message bridge
- `injected.js` — page-side entry point (message handlers, UA spoofing, console helpers)
- `rayneo-hid.js` — WebHID driver + Mahony sensor fusion (the new code)
- `webxr-polyfill.js` — WebXR device polyfill (incl. `XRWebGLBinding` compatibility stub)
- `youtube-vr.js` — YouTube head-tracking bridge, player-bar button, console fallback view
- `injected-bundle.js` — **generated** file: the four sources above concatenated into one MAIN-world content script (page CSP cannot block it). Do not edit directly.
- `build-bundle.sh` — regenerates `injected-bundle.js` and syntax-checks it (run after any source edit)
- `popup.html/js` — extension popup UI

## Troubleshooting

### "WebHID not supported" error
Use Chrome, Edge, or Opera. Firefox and Safari don't support WebHID.

### Device not appearing in connection dialog
- Ensure the glasses are connected via USB-C
- Try unplugging and reconnecting
- On macOS, make sure no other app (RayNeoPin, etc.) is holding the HID interface

### View rotates the wrong way or inverted
The axis convention above comes from protocol research; if your unit disagrees (firmware differences exist), the fix is a constant pre-rotation in `rayneo-hid.js` — see the `_fuse()` pose step. Open an issue with the console log from `RAYNEO_DEBUG = true` in `rayneo-hid.js`.

### Tracking feels drifty
Keep the glasses on and let the rest-detection refine the bias (it works while you're still), or recenter. First 1.5 s after connecting must be still for calibration.

## Credits

- Original extension: [bfvogel/viture-webxr-extension](https://github.com/bfvogel/viture-webxr-extension) (MIT) — WebXR polyfill, injection architecture and popup UI are adapted from it
- RayNeo USB protocol research: [verncat/RayNeo-Air-3S-Pro-OpenVR](https://github.com/verncat/RayNeo-Air-3S-Pro-OpenVR), [Fuut4/rayneo-pin](https://github.com/Fuut4/rayneo-pin), [informalTechCode/RayNeo-Air-Series-3DoF-Scaffold](https://github.com/informalTechCode/RayNeo-Air-Series-3DoF-Scaffold)
- Sensor fusion approach (Mahony filter, rest-detection-based gyro bias refinement) follows established open-source AHRS practice
- [google/spatial-media](https://github.com/google/spatial-media) Spherical Video V2 spec — reference for the VR180/360 mesh projection format used when analyzing YouTube VR videos

## License

MIT License — Use freely for any purpose.
