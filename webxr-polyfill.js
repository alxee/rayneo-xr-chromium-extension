/**
 * RayNeo WebXR Polyfill
 * Makes RayNeo glasses appear as a WebXR device
 */

// Debug flag - set to true for verbose logging
const RAYNEO_DEBUG = false;

function debugLog(...args) {
  if (RAYNEO_DEBUG) console.log(...args);
}

import { RayNeoHID } from './rayneo-hid.js';

// ------------------------------------------------- VR presentation helpers
// While an immersive session is live the screen is a headset mirror: the
// mouse cursor and the site's own player chrome only distract. These
// helpers hide the cursor globally, optionally hide site-matched elements,
// and focus/fullscreen the site's XR canvas.

function vrPresentationApply(on) {
  let sel = '';
  try { sel = localStorage.getItem('rayneo-hide-ui') || ''; } catch (e) { /* noop */ }
  let st = document.getElementById('rayneo-vr-presentation');
  if (!on) {
    if (st) st.remove();
    return;
  }
  if (!st) {
    st = document.createElement('style');
    st.id = 'rayneo-vr-presentation';
    (document.head || document.documentElement).appendChild(st);
  }
  st.textContent = '* { cursor: none !important; }'
    + (sel ? sel + ' { display: none !important; }' : '');
}

// Persist (per-site) a CSS selector to hide while VR is active.
// Usage: __rayneoHideUI('.player-controls, .site-header')  — pass no
// argument to clear.
window.__rayneoHideUI = function (selector) {
  try {
    if (selector) {
      localStorage.setItem('rayneo-hide-ui', selector);
      console.log('RayNeo: will hide "' + selector + '" on this site while VR is active (applies to new sessions; run __rayneoDiag style reload to test)');
    } else {
      localStorage.removeItem('rayneo-hide-ui');
      console.log('RayNeo: per-site UI hiding cleared');
    }
  } catch (e) {
    console.warn('RayNeo: localStorage unavailable:', e);
  }
};

// Fullscreen the largest visible canvas (the site's XR renderer) so the
// browser chrome and page UI drop away. Also runs automatically on session
// start when the entry click's user-activation is still valid.
window.__rayneoVRFocus = function () {
  const canvases = [...document.querySelectorAll('canvas')]
    .filter(c => c.offsetWidth && c.offsetHeight)
    .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
  const target = canvases[0] || document.documentElement;
  if (target.requestFullscreen) {
    return target.requestFullscreen().catch(e => {
      console.log('RayNeo: fullscreen rejected:', e && e.message);
    });
  }
};

// After the SBS command the OS needs a moment to re-arrange the glasses
// display (1920x1080 -> 3840x1080). If the session - and with it the
// fullscreen - starts during that window, it opens as a 1920-wide screen and
// the stereo image comes up squeezed. Wait until the screen geometry reflects
// the new mode before resolving; the site's requestSession() (and everything
// it does afterwards, including its own fullscreen) only continues then.
function settleDisplayAfterModeChange(baselineWidth) {
  // Already in a wide arrangement (re-entering VR, or the glasses always
  // report the wide mode): nothing to wait for
  if (screen.width >= 3000) return Promise.resolve();

  const CAP_MS = 3000;    // observed transitions take up to ~2-3 s
  const start = performance.now();

  function poll() {
    // Mode change observed: give the compositor a beat to apply the new
    // geometry, then let the session start
    if (screen.width !== baselineWidth && screen.width > 0) {
      return new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (performance.now() - start >= CAP_MS) {
      // Cannot observe the change (e.g. the window sits on another screen).
      // Don't stall VR entry forever - the panel command itself has had the
      // full cap to take effect by now.
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, 100)).then(poll);
  }

  return poll();
}

// While the glasses' display transition is pending (SBS command sent, OS
// still re-arranging), players that fullscreen themselves on VR entry would
// open a 1920-wide fullscreen and render the stereo image squeezed. Defer
// their requestFullscreen() calls until the transition completes.
let displaySettling = false;
let displaySettledOnce = false;
let settlingBaselineWidth = 0;

class RayNeoXRSession {
  constructor(mode, rayneo) {
    this.mode = mode;
    this.rayneo = rayneo;
    this.ended = false;
    this.renderState = {
      baseLayer: null,
      depthFar: 1000,
      depthNear: 0.1,
      inlineVerticalFieldOfView: Math.PI / 2
    };
    this.inputSources = [];
    this._frameCallbacks = [];
    this._animationFrameId = null;
    this._referenceSpaces = new Map();
    this._lastFrameTime = 0;

    // Set isImmersive as a data property (some apps try to set it)
    this.isImmersive = (mode === 'immersive-vr' || mode === 'immersive-ar');

    // Immersive sessions present side-by-side stereo to the glasses: switch
    // the panel into SBS mode automatically, and back to 2D when the session
    // ends (the site's normal playback must not stay split).
    if (this.isImmersive && this.rayneo.connected) {
      this.rayneo.setStereo(true).catch(() => {});
      // Register this tab as "presenting VR content" with the extension: if
      // the tab is closed without the session ending, the extension switches
      // the glasses back to 2D (see background.js tab-close handling).
      window.postMessage({ type: 'RAYNEO_VR_SESSION_STARTED' }, '*');
    }

    // Headset-mirror presentation: hide cursor/UI, try to fullscreen the
    // site's XR canvas (works when the session start still carries the
    // click's user activation; otherwise run __rayneoVRFocus() manually)
    if (this.isImmersive) {
      vrPresentationApply(true);
      window.__rayneoVRFocus();
    }

    // Start frame loop
    this._startFrameLoop();
  }

  get visibilityState() {
    return 'visible';
  }

  get frameRate() {
    return 60; // RayNeo Air 4 Pro native SBS refresh rate
  }

  get supportedFrameRates() {
    return Float32Array.from([60, 120]);
  }

  updateTargetFrameRate(rate) {
    // Accept and ignore: we always present at the panel's native rate
    return Promise.resolve();
  }

  get environmentBlendMode() {
    return 'opaque';
  }

  get interactionMode() {
    return 'world-space';
  }

  addEventListener(type, listener) {
    // Basic event handling
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    if (!this._listeners || !this._listeners[type]) return;
    const idx = this._listeners[type].indexOf(listener);
    if (idx !== -1) this._listeners[type].splice(idx, 1);
  }

  _dispatchEvent(type, event) {
    if (!this._listeners || !this._listeners[type]) return;
    this._listeners[type].forEach(l => l(event));
  }

  async requestReferenceSpace(type) {
    // One-time visibility: which spaces does the app use?
    if (!this._rsTypesLogged) this._rsTypesLogged = new Set();
    if (!this._rsTypesLogged.has(type)) {
      this._rsTypesLogged.add(type);
      console.log('[RayNeo polyfill] requestReferenceSpace("' + type + '")');
    }
    if (this._referenceSpaces.has(type)) {
      return this._referenceSpaces.get(type);
    }

    const space = new RayNeoXRReferenceSpace(type, this.rayneo);
    this._referenceSpaces.set(type, space);
    return space;
  }

  updateRenderState(newState) {
    if (!this._renderStateLogged) {
      this._renderStateLogged = true;
      const keys = Object.keys(newState || {});
      console.log('[RayNeo polyfill] updateRenderState:', keys.length ? keys.join(', ') : '(empty)');
    }
    Object.assign(this.renderState, newState);
  }

  requestAnimationFrame(callback) {
    const handle = this._frameCallbacks.length;
    this._frameCallbacks.push(callback);
    return handle;
  }

  cancelAnimationFrame(handle) {
    if (handle < this._frameCallbacks.length) {
      this._frameCallbacks[handle] = null;
    }
  }

  _startFrameLoop() {
    const loop = (timestamp) => {
      if (this.ended) return;

      this._animationFrameId = requestAnimationFrame(loop);

      // Keep the drawing buffer at the native SBS size: sites may resize
      // their canvas mid-session from stale window geometry (e.g. on the
      // fullscreen resize event), which would shrink each eye back to a
      // quarter of the panel
      const layer = this._layer;
      if (layer) {
        const canvas = layer.context.canvas;
        if (canvas.width !== layer._framebufferWidth || canvas.height !== layer._framebufferHeight) {
          try {
            canvas.width = layer._framebufferWidth;
            canvas.height = layer._framebufferHeight;
          } catch (e) { /* site owns the canvas; keep its size */ }
        }
      }

      // Create XRFrame
      const frame = new RayNeoXRFrame(this, timestamp);

      // Call all registered callbacks
      const callbacks = this._frameCallbacks.slice();
      this._frameCallbacks = [];

      callbacks.forEach(cb => {
        if (cb) cb(timestamp, frame);
      });

      this._lastFrameTime = timestamp;
    };

    this._animationFrameId = requestAnimationFrame(loop);
  }

  async end() {
    this.ended = true;
    if (this._animationFrameId) {
      cancelAnimationFrame(this._animationFrameId);
    }
    // Restore the glasses' panel to 2D for normal desktop use
    if (this.isImmersive && this.rayneo.connected) {
      try { await this.rayneo.setStereo(false); } catch (e) { /* noop */ }
    }
    // Leave presentation mode: restore cursor/UI and browser chrome
    if (this.isImmersive) {
      vrPresentationApply(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      // Normal exit path: the panel is back in 2D, so the extension no longer
      // needs to watch this tab for a close-while-in-SBS situation
      window.postMessage({ type: 'RAYNEO_VR_SESSION_ENDED' }, '*');
    }
    this._dispatchEvent('end', { session: this });
  }
}

class RayNeoXRFrame {
  constructor(session, timestamp) {
    this.session = session;
    this._timestamp = timestamp;
  }

  getViewerPose(referenceSpace) {
    if (!referenceSpace) return null;
    this.session._frameCount = (this.session._frameCount || 0) + 1;
    if (!this.session._viewerPoseLogged) {
      this.session._viewerPoseLogged = true;
      console.log('[RayNeo polyfill] getViewerPose called - tracking is flowing to the app');
    }
    return new RayNeoXRViewerPose(this.session, referenceSpace);
  }

  getPose(space, baseSpace) {
    // Return identity pose for now
    return {
      transform: new RayNeoXRRigidTransform()
    };
  }
}

class RayNeoXRViewerPose {
  constructor(session, referenceSpace) {
    this.session = session;
    this.referenceSpace = referenceSpace;

    // Get quaternion from RayNeo device
    const q = session.rayneo.connected ? session.rayneo.getQuaternion() : { x: 0, y: 0, z: 0, w: 1 };

    // Debug: Log quaternion periodically
    if (!RayNeoXRViewerPose._lastLog || (Date.now() - RayNeoXRViewerPose._lastLog > 1000)) {
      debugLog('RayNeoXRViewerPose: quaternion', q, 'connected:', session.rayneo.connected);
      RayNeoXRViewerPose._lastLog = Date.now();
    }

    this.transform = new RayNeoXRRigidTransform(
      { x: 0, y: 0, z: 0, w: 1 },
      q
    );

    // For stereo, create two views
    if (session.mode === 'immersive-vr') {
      this.views = [
        new RayNeoXRView('left', session),
        new RayNeoXRView('right', session)
      ];
    } else {
      this.views = [new RayNeoXRView('none', session)];
    }
  }

  get emulatedPosition() {
    return true; // Position is emulated (3DoF only)
  }
}

class RayNeoXRView {
  constructor(eye, session) {
    this.eye = eye;
    this.session = session;

    // RayNeo Air 4 Pro FOV is approximately 45 degrees
    const fov = 45 * Math.PI / 180;
    const aspect = 16 / 9;

    this.projectionMatrix = new Float32Array(16);
    this._makePerspective(this.projectionMatrix, fov, aspect, 0.1, 1000);

    // View transform includes eye offset for stereo
    const q = session.rayneo.connected ? session.rayneo.getQuaternion() : { x: 0, y: 0, z: 0, w: 1 };
    const eyeOffset = eye === 'left' ? -0.032 : (eye === 'right' ? 0.032 : 0);

    this.transform = new RayNeoXRRigidTransform(
      { x: eyeOffset, y: 0, z: 0, w: 1 },
      q
    );

    // recommendedViewportScale is used by some apps
    this.recommendedViewportScale = 1.0;
  }

  _makePerspective(out, fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);

    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[14] = 2 * far * near * nf;
    out[15] = 0;
  }
}

class RayNeoXRReferenceSpace {
  constructor(type, rayneo) {
    this.type = type;
    this.rayneo = rayneo;
  }

  getOffsetReferenceSpace(originOffset) {
    return new RayNeoXRReferenceSpace(this.type, this.rayneo);
  }

  addEventListener() {}
  removeEventListener() {}
}

class RayNeoXRRigidTransform {
  constructor(position = { x: 0, y: 0, z: 0, w: 1 }, orientation = { x: 0, y: 0, z: 0, w: 1 }, isInverse = false) {
    this.position = new DOMPointReadOnly(position.x, position.y, position.z, position.w || 1);
    this.orientation = new DOMPointReadOnly(orientation.x, orientation.y, orientation.z, orientation.w);

    // Build 4x4 transformation matrix
    this.matrix = new Float32Array(16);
    this._buildMatrix();

    // Compute inverse (but don't recurse infinitely)
    if (!isInverse) {
      this._inverse = null; // Lazy compute
    } else {
      this._inverse = null; // Inverse of inverse would be the original, but we don't need it
    }
    this._isInverse = isInverse;
  }

  get inverse() {
    if (this._inverse === null && !this._isInverse) {
      // Compute the inverse transform
      // Inverse rotation = conjugate quaternion
      const invOrientation = {
        x: -this.orientation.x,
        y: -this.orientation.y,
        z: -this.orientation.z,
        w: this.orientation.w
      };

      // Inverse position = -R^T * position
      // Apply inverse rotation to negated position
      const p = this.position;
      const q = invOrientation;

      // Rotate -position by inverse quaternion
      const px = -p.x, py = -p.y, pz = -p.z;

      // Quaternion rotation: q * p * q^-1
      // Since q is already the inverse rotation, we just apply it
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

      // p' = q * (px, py, pz, 0) * q^-1
      // Simplified quaternion-vector multiplication
      const ix = qw * px + qy * pz - qz * py;
      const iy = qw * py + qz * px - qx * pz;
      const iz = qw * pz + qx * py - qy * px;
      const iw = -qx * px - qy * py - qz * pz;

      const invPx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
      const invPy = iy * qw + iw * -qy + iz * -qx - ix * -qz;
      const invPz = iz * qw + iw * -qz + ix * -qy - iy * -qx;

      this._inverse = new RayNeoXRRigidTransform(
        { x: invPx, y: invPy, z: invPz, w: 1 },
        invOrientation,
        true // Mark as inverse to prevent recursion
      );
    }
    return this._inverse;
  }

  _buildMatrix() {
    const q = this.orientation;
    const p = this.position;

    // Quaternion to rotation matrix
    const x2 = q.x + q.x;
    const y2 = q.y + q.y;
    const z2 = q.z + q.z;

    const xx = q.x * x2;
    const xy = q.x * y2;
    const xz = q.x * z2;
    const yy = q.y * y2;
    const yz = q.y * z2;
    const zz = q.z * z2;
    const wx = q.w * x2;
    const wy = q.w * y2;
    const wz = q.w * z2;

    this.matrix[0] = 1 - (yy + zz);
    this.matrix[1] = xy + wz;
    this.matrix[2] = xz - wy;
    this.matrix[3] = 0;
    this.matrix[4] = xy - wz;
    this.matrix[5] = 1 - (xx + zz);
    this.matrix[6] = yz + wx;
    this.matrix[7] = 0;
    this.matrix[8] = xz + wy;
    this.matrix[9] = yz - wx;
    this.matrix[10] = 1 - (xx + yy);
    this.matrix[11] = 0;
    this.matrix[12] = p.x;
    this.matrix[13] = p.y;
    this.matrix[14] = p.z;
    this.matrix[15] = 1;
  }
}

/**
 * XRWebGLLayer polyfill for RayNeo sessions
 */
// Native SBS panel layout of the RayNeo Air glasses: 3840x1080 total,
// 1920x1080 per eye. Immersive sessions always render side-by-side stereo,
// so the drawing buffer must match this regardless of what resolution the
// OS currently drives the panel at (the display mode can lag the panel
// switch by a second or more).
const SBS_FRAMEBUFFER_WIDTH = 3840;
const SBS_FRAMEBUFFER_HEIGHT = 1080;

class RayNeoXRWebGLLayer {
  constructor(session, context, options = {}) {
    this.session = session;
    this.context = context;
    this._options = options;

    // Get canvas dimensions
    const canvas = context.canvas;

    // Immersive session: the site sizes its canvas from window geometry that
    // can be stale (captured before the display switched to the wide/SBS
    // arrangement, or while the window was still on another screen) - the
    // stereo image then renders 1920-wide and each eye ends up squeezed into
    // a quarter of the panel. Force the drawing buffer to the panel's native
    // SBS size and keep it enforced for the session's lifetime (frame loop).
    if (session.isImmersive) {
      try {
        canvas.width = SBS_FRAMEBUFFER_WIDTH;
        canvas.height = SBS_FRAMEBUFFER_HEIGHT;
      } catch (e) { /* site owns the canvas; keep its size */ }
      // Make the layer reachable from the frame loop for re-enforcement
      session._layer = this;
    }

    this._framebufferWidth = canvas.width;
    this._framebufferHeight = canvas.height;

    // Store original framebuffer (null = default)
    this._framebuffer = null;

    // Mark session with this layer
    if (session.updateRenderState) {
      // Will be called by the app
    }

    debugLog('RayNeoXRWebGLLayer created:', this._framebufferWidth, 'x', this._framebufferHeight);
  }

  get framebuffer() {
    return this._framebuffer;
  }

  get framebufferWidth() {
    return this._framebufferWidth;
  }

  get framebufferHeight() {
    return this._framebufferHeight;
  }

  get antialias() {
    return this._options.antialias !== false;
  }

  get ignoreDepthValues() {
    return this._options.ignoreDepthValues || false;
  }

  getViewport(view) {
    // For stereo, split viewport left/right
    const width = this._framebufferWidth;
    const height = this._framebufferHeight;

    if (view.eye === 'left') {
      return { x: 0, y: 0, width: width / 2, height: height };
    } else if (view.eye === 'right') {
      return { x: width / 2, y: 0, width: width / 2, height: height };
    } else {
      // Mono view
      return { x: 0, y: 0, width: width, height: height };
    }
  }
}

class RayNeoXRSystem {
  constructor(rayneo) {
    this.rayneo = rayneo;
    this._sessions = [];
  }

  async isSessionSupported(mode) {
    // Disabled via popup toggle -> pretend XR isn't available
    if (window.__rayneoDisabled) {
      return mode === 'inline' && originalXR ? originalXR.isSessionSupported(mode) : false;
    }
    // Support inline and immersive-vr modes
    return mode === 'inline' || mode === 'immersive-vr';
  }

  async requestSession(mode, options = {}) {
    if (window.__rayneoDisabled) {
      throw new DOMException('RayNeo WebXR is disabled', 'InvalidStateError');
    }
    debugLog('RayNeoXRSystem: requestSession called', mode, 'connected:', this.rayneo.connected);

    if (mode === 'immersive-vr' && !this.rayneo.connected) {
      // First try devices the user already authorized (no gesture needed),
      // then fall back to the full WebHID permission flow
      try {
        await this.rayneo.checkExistingConnection();
      } catch (e) { /* fall through */ }

      if (!this.rayneo.connected) {
        debugLog('RayNeoXRSystem: Attempting to connect to RayNeo glasses...');
        try {
          await this.rayneo.connect();
          debugLog('RayNeoXRSystem: Connected successfully');
        } catch (e) {
          debugLog('RayNeoXRSystem: Connection failed:', e);
          throw new DOMException('Failed to connect to RayNeo glasses: ' + e.message, 'NotSupportedError');
        }
      }
    }

    const session = new RayNeoXRSession(mode, this.rayneo);
    this._sessions.push(session);
    const feats = options && options.optionalFeatures ? options.optionalFeatures.join(',') : '';
    console.log(`[RayNeo polyfill] session created (${mode})` + (feats ? ` optionalFeatures: ${feats}` : ''));
    return session;
  }
}

// Global RayNeo instance
let globalRayNeo = null;
let globalXRSystem = null;

export function initRayNeoWebXR() {
  if (globalRayNeo) return globalXRSystem;

  globalRayNeo = new RayNeoHID();
  globalXRSystem = new RayNeoXRSystem(globalRayNeo);

  // Check for existing connection
  globalRayNeo.checkExistingConnection().catch(() => {});

  // Store original XR if exists
  const originalXR = navigator.xr;

  // Create proxy XR system

  // Sites whose players must see "VR available" even before the glasses are
  // connected: they gate their entire VR UI on that check and never enter VR
  // on their own. On other sites we must NOT advertise VR until the glasses
  // are connected — some players (e.g. pornhub) detect a "headset" and
  // auto-request a WebXR session, which hijacks/stalls their normal player.
  const ALWAYS_OFFER_VR_HOSTS = ['deovr.com'];
  const hostAllowlisted = ALWAYS_OFFER_VR_HOSTS.some(
    h => location.hostname === h || location.hostname.endsWith('.' + h)
  );
  // Per-site opt-in set by the user (popup "VR mode on this site" button or
  // the __rayneoVRMode() console command); stored in the site's localStorage.
  let userForcedVR = false;
  try { userForcedVR = localStorage.getItem('rayneo-vr-force') === '1'; } catch (e) { /* noop */ }
  const alwaysOfferVR = hostAllowlisted || userForcedVR;

  // An authorized RayNeo device counts as "connected" for advertising and
  // session purposes: after a page reload the driver re-opens the device
  // asynchronously, but sites check isSessionSupported once at load —
  // before reconnection finishes. Without this, sites conclude "no
  // headset" and never re-check.
  async function rayneoReady() {
    if (globalRayNeo.connected) return true;
    try {
      const devices = await navigator.hid.getDevices();
      return devices.some(d =>
        RayNeoHID.VENDOR_IDS.includes(d.vendorId) && RayNeoHID.PRODUCT_IDS.includes(d.productId)
      );
    } catch (e) {
      return false;
    }
  }

  const proxyXR = {
    async isSessionSupported(mode) {
      const result = await this._isSessionSupportedInner(mode);
      // Temporary visibility into what sites ask us (helps debug DeoVR/YouTube)
      console.log('[RayNeo polyfill] isSessionSupported("' + mode + '") ->', result);
      return result;
    },

    async _isSessionSupportedInner(mode) {
      // Disabled via popup toggle -> pretend XR isn't available
      if (window.__rayneoDisabled) {
        return mode === 'inline' && originalXR ? originalXR.isSessionSupported(mode) : false;
      }
      // Connected (or authorized, reconnecting) RayNeo device
      const rayneoSupportsMode = await globalXRSystem.isSessionSupported(mode);
      const rayneoReadyNow = await rayneoReady();
      if (rayneoSupportsMode && rayneoReadyNow) {
        return true;
      }

      // For immersive-vr we can start a session (the connect happens on
      // request) — but only where it is safe to advertise: on known VR
      // player sites, or once the user has actually connected the glasses.
      // This must be checked BEFORE falling back to the real navigator.xr,
      // otherwise desktop Chrome's "false" wins and sites like DeoVR decide
      // there is no headset at all.
      if (mode === 'immersive-vr' && RayNeoHID.isSupported() && (alwaysOfferVR || globalRayNeo.connected)) {
        return true;
      }

      // Fall back to original WebXR if available
      if (originalXR) {
        return originalXR.isSessionSupported(mode);
      }

      return mode === 'inline';
    },

    async requestSession(mode, options) {
      console.log('[RayNeo polyfill] requestSession("' + mode + '")', options || '');
      debugLog('RayNeo WebXR proxy: requestSession', mode, options);

      // Prefer RayNeo for immersive-vr — but only where advertising VR was
      // allowed (known VR sites) or the user explicitly connected the
      // glasses on this page. Otherwise reject like a desktop without a
      // headset would, instead of letting sites auto-enter VR.
      if (mode === 'immersive-vr') {
        if (!alwaysOfferVR && !(await rayneoReady())) {
          debugLog('RayNeo WebXR proxy: refusing immersive-vr (no glasses connected on this site)');
          const err = new Error('No RayNeo glasses connected on this site — connect via the extension popup first.');
          return Promise.reject(err);
        }
        // Connect first (if needed) so the display mode switch starts as
        // early as possible
        if (!globalRayNeo.connected) {
          try {
            await globalRayNeo.checkExistingConnection();
          } catch (e) { /* fall through */ }
          if (!globalRayNeo.connected) {
            try {
              await globalRayNeo.connect();
            } catch (e) {
              debugLog('RayNeo WebXR proxy: Connection failed:', e);
              return Promise.reject(new DOMException('Failed to connect to RayNeo glasses: ' + e.message, 'NotSupportedError'));
            }
          }
        }
        // Switch the panel to SBS NOW and wait for the OS to re-arrange the
        // display: a session created during the switch renders for the stale
        // 1920-wide resolution. Skipped when "auto mode switch" is off in the
        // popup (the user controls the panel mode).
        if (window.__rayneoAutoModeSwitch !== false && globalRayNeo.connected) {
          const baselineWidth = screen.width;
          displaySettling = true;
          displaySettledOnce = false;
          settlingBaselineWidth = baselineWidth;
          await globalRayNeo.setStereo(true);
          await settleDisplayAfterModeChange(baselineWidth);
          displaySettling = false;
          displaySettledOnce = true;
        }
        debugLog('RayNeo WebXR proxy: Using RayNeo for immersive-vr');
        return globalXRSystem.requestSession(mode, options);
      }

      // For inline, use original if available
      if (originalXR && mode === 'inline') {
        try {
          debugLog('RayNeo WebXR proxy: Trying original XR for inline');
          return await originalXR.requestSession(mode, options);
        } catch (e) {
          debugLog('RayNeo WebXR proxy: Original XR failed, falling back to RayNeo');
          return globalXRSystem.requestSession(mode, options);
        }
      }

      return globalXRSystem.requestSession(mode, options);
    },

    addEventListener(type, listener) {
      if (originalXR) {
        originalXR.addEventListener(type, listener);
      }
    },

    removeEventListener(type, listener) {
      if (originalXR) {
        originalXR.removeEventListener(type, listener);
      }
    },

    // Expose RayNeo-specific methods
    get rayneo() {
      return globalRayNeo;
    }
  };

  // Replace navigator.xr
  Object.defineProperty(navigator, 'xr', {
    get: () => proxyXR,
    configurable: true
  });

  // Override XRWebGLLayer to handle RayNeo sessions
  const OriginalXRWebGLLayer = window.XRWebGLLayer;

  window.XRWebGLLayer = function(session, context, options) {
    // Check if this is a RayNeo session
    if (session instanceof RayNeoXRSession) {
      debugLog('Creating RayNeoXRWebGLLayer for RayNeo session');
      return new RayNeoXRWebGLLayer(session, context, options);
    }

    // Fall back to original for real XR sessions
    if (OriginalXRWebGLLayer) {
      return new OriginalXRWebGLLayer(session, context, options);
    }

    // No original XRWebGLLayer, create our polyfill
    return new RayNeoXRWebGLLayer(session, context, options);
  };

  // Copy static properties
  if (OriginalXRWebGLLayer) {
    window.XRWebGLLayer.getNativeFramebufferScaleFactor = function(session) {
      // Our polyfilled sessions have no native framebuffer scale
      if (session instanceof RayNeoXRSession) return 1.0;
      return OriginalXRWebGLLayer.getNativeFramebufferScaleFactor(session);
    };
  } else {
    window.XRWebGLLayer.getNativeFramebufferScaleFactor = function(session) {
      return 1.0;
    };
  }

  // Override XRWebGLBinding: the native constructor (present in Chromium) type-
  // checks its first argument and throws on our polyfilled sessions
  // ("parameter 1 is not of type 'XRSession'"), crashing apps like three.js.
  // Provide a stub for RayNeo sessions. Its prototype deliberately does NOT
  // have createProjectionLayer, so apps that check for it (three.js:
  // 'createProjectionLayer' in XRWebGLBinding.prototype) detect "no layers
  // support" and fall back to the classic XRWebGLLayer path, which this
  // polyfill fully implements.
  const NativeXRWebGLBinding = window.XRWebGLBinding;
  window.XRWebGLBinding = class RayNeoXRWebGLBindingStub {
    constructor(session, context, options) {
      if (session instanceof RayNeoXRSession) {
        debugLog('RayNeoXRWebGLBinding stub created for RayNeo session');
        this.session = session;
        this.context = context;
        return;
      }
      if (NativeXRWebGLBinding) {
        return new NativeXRWebGLBinding(session, context, options);
      }
      throw new TypeError('XRWebGLBinding requires a real XR session');
    }
    // NOTE: no createProjectionLayer on purpose — see comment above.
  };

  // Defer fullscreen requests made while the glasses' display transition is
  // pending: players (DeoVR etc.) call requestFullscreen() themselves the
  // moment they enter VR - before requestSession resolves - and would
  // fullscreen at the stale 1920x1080 arrangement. Hold those calls until
  // the display reports the wide mode, then run them with fresh geometry.
  const nativeRequestFullscreen = Element.prototype.requestFullscreen;
  if (nativeRequestFullscreen) {
    Element.prototype.requestFullscreen = function (...args) {
      if (!displaySettling || displaySettledOnce) {
        return nativeRequestFullscreen.apply(this, args);
      }
      debugLog('RayNeo polyfill: deferring requestFullscreen() until display transition completes');
      return settleDisplayAfterModeChange(settlingBaselineWidth)
        .then(() => nativeRequestFullscreen.apply(this, args));
    };
  }

  // Patch makeXRCompatible: on a desktop browser with no real XR device,
  // the browser's native makeXRCompatible() can stay pending forever, which
  // silently kills apps that do gl.makeXRCompatible().then(setup) — DeoVR's
  // enter-VR chain swallows errors (.catch(() => G=0)), so the hang is
  // invisible. Wrap it: call the original, but race a short timeout that
  // force-resolves true so the app's XR setup always proceeds.
  const patchMakeXRCompatible = (proto) => {
    if (!proto || typeof proto.makeXRCompatible !== 'function') return;
    const original = proto.makeXRCompatible;
    proto.makeXRCompatible = function (...args) {
      console.log('[RayNeo polyfill] makeXRCompatible called');
      let settled = false;
      const origPromise = original.apply(this, args).then((v) => {
        settled = true;
        console.log('[RayNeo polyfill] makeXRCompatible resolved natively:', v);
        return v;
      });
      return Promise.race([
        origPromise.catch((e) => {
          settled = true;
          console.log('[RayNeo polyfill] makeXRCompatible rejected natively, forcing true:', e && e.message);
          return true;
        }),
        new Promise((resolve) => setTimeout(() => {
          if (!settled) {
            console.log('[RayNeo polyfill] makeXRCompatible still pending after 2s - force-resolving true');
          }
          resolve(true);
        }, 2000))
      ]);
    };
  };
  if (window.WebGL2RenderingContext) patchMakeXRCompatible(WebGL2RenderingContext.prototype);
  if (window.WebGLRenderingContext) patchMakeXRCompatible(WebGLRenderingContext.prototype);

  debugLog('RayNeo WebXR polyfill initialized');
  return globalXRSystem;
}

// Expose for manual control
window.RayNeoWebXR = {
  init: initRayNeoWebXR,
  getRayNeo: () => globalRayNeo,
  getRayneo: () => globalRayNeo, // lowercase alias, avoids casing mistakes in the console
  getXRSystem: () => globalXRSystem
};

// Quick diagnostics shortcut for support/debugging
window.__rayneoDiag = function () {
  const d = globalRayNeo ? globalRayNeo.getDiagnostics() : { connected: false, error: 'not initialized' };
  const q = d.quaternion || {};
  const qs = q.w !== undefined
    ? `w:${q.w.toFixed(2)} x:${q.x.toFixed(2)} y:${q.y.toFixed(2)} z:${q.z.toFixed(2)}`
    : 'n/a';
  console.log(`RayNeo diag: connected=${d.connected} reports=${d.reportsReceived} imuFrames=${d.imuFramesParsed} calibrated=${d.biasCalibrated} quaternion=${qs}`);
  // XR session status: how many sessions, and is the app's render loop
  // actually pumping frames (frameCount should rise while you watch it)
  const sess = globalXRSystem && globalXRSystem._sessions ? globalXRSystem._sessions.filter(s => !s.ended) : [];
  sess.forEach((s, i) => {
    const before = s._frameCount || 0;
    setTimeout(() => {
      const after = s._frameCount || 0;
      console.log(`RayNeo xr session[${i}] mode=${s.mode} frames=${before}->${after} (+${(after - before) / 2}/s) stereo=${s.renderState.baseLayer ? 'baseLayer-set' : 'none'}`);
    }, 2000);
  });
  console.log(`RayNeo xr sessions active: ${sess.length}`);
  console.log('  -> frame counter measured over 2 s; ~60/s means the site render loop is running');
  return d;
};
