/**
 * RayNeo WebXR Extension - Injected Script
 * This runs in the page context and initializes the WebXR polyfill
 */

// DeoVR headset gate: their webxr loader (webxr-init.js) decides "is there a
// headset" purely by parsing navigator.userAgent for OculusBrowser/PicoBrowser
// tokens (get_HMD returns NONE=0 for desktop UAs, regardless of what
// navigator.xr reports). Spoof a Quest-3-like UA on deovr.com so their
// immersive webxr path activates with our polyfill.
(function () {
  if (!/(^|\.)deovr\.com$/.test(location.hostname)) return;
  const ua = navigator.userAgent;
  if (ua.includes('OculusBrowser') || ua.includes('PicoBrowser')) return;
  // Add "Quest 3" as the third platform token and append the OculusBrowser
  // token: their get_HMD() maps platform token 3 + OculusBrowser -> QUEST_3
  const spoofed = ua.replace(/\(([^)]*)\)/, (m, inner) => `(${inner}; Quest 3)`)
    + ' OculusBrowser/20.1.0.0.137';
  try {
    Object.defineProperty(navigator, 'userAgent', { get: () => spoofed, configurable: true });
    Object.defineProperty(navigator, 'appVersion', { get: () => spoofed.replace('Mozilla/', ''), configurable: true });
    console.log('RayNeo: spoofed UA for DeoVR headset detection (Quest 3)');
  } catch (e) {
    console.warn('RayNeo: could not override userAgent:', e);
  }
})();

import { RayNeoHID } from './rayneo-hid.js';
import { initRayNeoWebXR } from './webxr-polyfill.js';

// Initialize immediately
const xrSystem = initRayNeoWebXR();

// Listen for state changes from extension
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;

  const data = event.data;

  if (data.type === 'RAYNEO_STATE_RESPONSE') {
    console.log('RayNeo extension state:', data.state);
  }

  if (data.type === 'RAYNEO_STATE_CHANGED') {
    // Respect the popup's enable toggle even though we load statically
    window.__rayneoDisabled = !(data.state && data.state.enabled);
    if (window.__rayneoDisabled) {
      console.log('RayNeo WebXR disabled');
    }
  }

  if (data.type === 'RAYNEO_CONNECT_REQUEST') {
    console.log('RayNeo connect request received');
    try {
      await window.connectRayNeo();
    } catch (e) {
      console.error('Failed to connect RayNeo:', e);
    }
  }

  if (data.type === 'RAYNEO_RECENTER_REQUEST') {
    console.log('RayNeo recenter request received');
    window.recenterRayNeo();
  }

  if (data.type === 'RAYNEO_ENTERVR_REQUEST') {
    // DeoVR (and similar canvas-UI players) expose their internal event bus;
    // event 177 is their "Enter VR" action which requests the XR session
    if (window.MU && typeof MU.events?.emit === 'function') {
      console.log('RayNeo: dispatching Enter VR event to player');
      MU.events.emit(177);
    } else {
      console.warn('RayNeo: no player event bus (window.MU) found on this page');
    }
  }

  if (data.type === 'RAYNEO_YTTRACK_REQUEST') {
    // Toggle head tracking for YouTube's own spherical renderer
    if (typeof window.__rayneoYouTubeTracking === 'function') {
      window.__rayneoYouTubeTracking();
    } else {
      console.warn('RayNeo: YouTube tracking not available on this page');
    }
  }
});

// Request initial state
window.postMessage({ type: 'RAYNEO_GET_STATE' }, '*');

// Expose manual connect function for debugging
window.connectRayNeo = async function() {
  const rayneo = window.RayNeoWebXR.getRayNeo();
  if (!rayneo) {
    console.error('RayNeo not initialized');
    return;
  }

  try {
    const info = await rayneo.connect();
    console.log('Connected to RayNeo:', info);
    return info;
  } catch (e) {
    console.error('Failed to connect:', e);
    throw e;
  }
};

// Expose recenter function
window.recenterRayNeo = function() {
  const rayneo = window.RayNeoWebXR.getRayNeo();
  if (rayneo && rayneo.connected) {
    rayneo.recenter();
    console.log('RayNeo recentered');
  } else {
    console.error('RayNeo not connected');
  }
};

// Log availability
console.log('RayNeo WebXR ready. WebHID supported:', RayNeoHID.isSupported());

// Dispatch event for pages that want to know when RayNeo is ready
window.dispatchEvent(new CustomEvent('rayneo-webxr-ready', {
  detail: {
    supported: RayNeoHID.isSupported(),
    connect: window.connectRayNeo,
    recenter: window.recenterRayNeo
  }
}));
