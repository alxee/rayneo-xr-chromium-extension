/**
 * RayNeo YouTube VR mode
 *
 * YouTube's desktop goggles/stereo button is unreliable (their player
 * experiments enable/disable it at random), so this module provides our own:
 * for 360/VR videos it injects a "RayNeo VR" button into the player bar that
 * opens a stereo WebGL overlay rendering the video with head tracking driven
 * directly by the RayNeo IMU - no WebXR involved.
 *
 * Supported layouts (detected from the player response):
 *   - EQUIRECTANGULAR mono  -> full 360 sphere, same image both eyes
 *   - EQUIRECTANGULAR + stereo (qualityLabel like "2160s") -> 360 side-by-side
 *   - MESH (VR180)          -> 180-degree sphere segment, side-by-side
 *
 * Console helpers:
 *   __rayneoYouTubeVR()          enter/exit the VR view
 *   __rayneoYouTubeVRInfo()      show what was detected for this video
 *   __rayneoYouTubeVRMirror()    flip left/right image mapping (if view looks mirrored)
 *   window.recenterRayNeo()      recenter yaw (also key "r" while in VR view)
 */

(function () {
  if (typeof window === 'undefined') return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const OVERLAY_Z = 2147483647;
  const DEFAULT_FOV = 60; // per-eye vertical FOV, degrees

  const state = {
    active: false,
    canvas: null,
    gl: null,
    program: null,
    buffers: null,
    texture: null,
    video: null,
    raf: 0,
    mode: null, // '360mono' | '360sbs' | '180sbs'
    sbs: false,
    mirror: false,
    ui: null,
    keyHandler: null,
    fsHandler: null
  };

  // ---------------------------------------------------------------- detect

  function getVRInfo() {
    try {
      const player = document.getElementById('movie_player');
      const pr = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
      if (!pr || !pr.streamingData) return null;

      const fmts = [
        ...(pr.streamingData.formats || []),
        ...(pr.streamingData.adaptiveFormats || [])
      ];

      let projection = null;
      let stereo = false;

      for (const f of fmts) {
        if (f.projectionType && f.projectionType !== 'RECTANGULAR') {
          projection = f.projectionType;
          // MESH is YouTube's VR180 format, which is always stereo
          if (f.projectionType === 'MESH') stereo = true;
        }
        // "2160s"-style quality labels mark stereoscopic streams
        if (f.qualityLabel && /^\d+s$/.test(f.qualityLabel)) stereo = true;
      }

      if (!projection) return null;

      const mode = projection === 'MESH'
        ? '180sbs'
        : (stereo ? '360sbs' : '360mono');

      return { projection, stereo, mode };
    } catch (e) {
      console.warn('[RayNeo YouTube VR] detection failed:', e);
      return null;
    }
  }

  // ------------------------------------------------------------ button

  function makeGogglesIcon() {
    // YouTube enforces Trusted Types, so innerHTML with SVG markup throws.
    // Build the SVG through the DOM API instead. Stroke-based eyeglasses
    // (two lenses + bridge + temple arms) so it reads clearly at 22px.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.style.width = '22px';
    svg.style.height = '22px';
    svg.style.display = 'block';

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('fill', 'none');
    g.style.stroke = '#fff';
    g.style.strokeWidth = '2';
    g.style.strokeLinecap = 'round';
    g.style.strokeLinejoin = 'round';

    const lens = (cx) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx);
      c.setAttribute('cy', '15');
      c.setAttribute('r', '4');
      return c;
    };
    const arm = (d) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      return p;
    };

    g.appendChild(lens(6));
    g.appendChild(lens(18));
    g.appendChild(arm('M14 15a2 2 0 0 0-2-2 2 2 0 0 0-2 2'));          // bridge
    g.appendChild(arm('M2.5 13 5 7c.7-1.3 1.4-2 3-2'));                 // left arm
    g.appendChild(arm('M21.5 13 19 7c-.7-1.3-1.5-2-3-2'));              // right arm
    svg.appendChild(g);
    return svg;
  }

  function ensureButton() {
    if (!/^\/watch/.test(location.pathname)) return;
    ensureStyles();

    const info = getVRInfo();
    const existing = document.getElementById('rayneo-vr-btn');
    if (!info) {
      if (existing) existing.remove();
      return;
    }

    const controls = document.querySelector('.ytp-right-controls');
    if (!controls || existing) return;

    const btn = document.createElement('button');
    btn.id = 'rayneo-vr-btn';
    btn.className = 'ytp-button';
    btn.title = 'RayNeo head tracking (YouTube view)';
    btn.appendChild(makeGogglesIcon());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTracking();
    });
    controls.insertBefore(btn, controls.firstChild);
  }

  // ------------------------------------------------------------ WebGL core

  const VERT_SRC =
    'attribute vec3 aPos;\n' +
    'attribute vec2 aUV;\n' +
    'uniform mat4 uVP;\n' +
    'varying vec2 vUV;\n' +
    'void main(){ gl_Position = uVP * vec4(aPos, 1.0); vUV = aUV; }';

  const FRAG_SRC =
    'precision mediump float;\n' +
    'varying vec2 vUV;\n' +
    'uniform sampler2D uTex;\n' +
    'uniform float uSbs;\n' +
    'uniform float uEye;\n' +
    'uniform float uMirror;\n' +
    'void main(){\n' +
    '  float u = vUV.x;\n' +
    '  if (uSbs > 0.5) u = uEye * 0.5 + u * 0.5;\n' +
    '  u = mix(u, 1.0 - u, uMirror);\n' +
    '  gl_FragColor = texture2D(uTex, vec2(u, vUV.y));\n' +
    '}';

  function mat4Mul(a, b) {
    // column-major a*b
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function perspective(fovyRad, aspect, near, far) {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) * nf; m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  }

  // Same convention as the WebXR polyfill's RayNeoXRRigidTransform: the driver
  // quaternion maps viewer -> world (x right, y up, -z forward). Camera sits
  // at the origin, so the view matrix is just the transpose (inverse) of the
  // world rotation.
  function viewFromQuaternion(q) {
    const x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
    const xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
    const yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
    const wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;

    // rotation matrix (column-major)
    const r = new Float32Array(16);
    r[0] = 1 - (yy + zz); r[1] = xy + wz; r[2] = xz - wy;
    r[4] = xy - wz; r[5] = 1 - (xx + zz); r[6] = yz + wx;
    r[8] = xz + wy; r[9] = yz - wx; r[10] = 1 - (xx + yy);
    r[15] = 1;

    // transpose -> view matrix
    const v = new Float32Array(16);
    v[0] = r[0]; v[1] = r[4]; v[2] = r[8];  v[3] = 0;
    v[4] = r[1]; v[5] = r[5]; v[6] = r[9];  v[7] = 0;
    v[8] = r[2]; v[9] = r[6]; v[10] = r[10]; v[11] = 0;
    v[12] = 0; v[13] = 0; v[14] = 0; v[15] = 1;
    return v;
  }

  function identityQuaternion() {
    return { x: 0, y: 0, z: 0, w: 1 };
  }

  function getOrientation() {
    try {
      const rayneo = window.RayNeoWebXR && window.RayNeoWebXR.getRayneo();
      if (rayneo && rayneo.connected) return rayneo.getQuaternion();
    } catch (e) { /* fall through */ }
    return identityQuaternion();
  }

  function buildGeometry(gl, mode) {
    // Sphere segment covering the video's yaw span, UVs normalized 0..1
    // across that span (fragment shader adds the eye's half for SBS).
    const yawSpan = mode === '180sbs' ? Math.PI : Math.PI * 2;
    const yawStart = mode === '180sbs' ? -Math.PI / 2 : -Math.PI;

    const SEG_U = 64, SEG_V = 48;
    const verts = new Float32Array((SEG_U + 1) * (SEG_V + 1) * 5);
    let vi = 0;
    for (let j = 0; j <= SEG_V; j++) {
      // v: 0 = image bottom (down), 1 = image top (up)
      const pitch = -Math.PI / 2 + (j / SEG_V) * Math.PI;
      for (let i = 0; i <= SEG_U; i++) {
        const u = i / SEG_U;
        const yaw = yawStart + u * yawSpan;
        const cp = Math.cos(pitch);
        verts[vi++] = Math.sin(yaw) * cp;          // x
        verts[vi++] = Math.sin(pitch);             // y
        verts[vi++] = -Math.cos(yaw) * cp;         // z (forward at yaw=0)
        verts[vi++] = u;
        verts[vi++] = j / SEG_V;
      }
    }

    const idx = new Uint16Array(SEG_U * SEG_V * 6);
    let ii = 0;
    for (let j = 0; j < SEG_V; j++) {
      for (let i = 0; i < SEG_U; i++) {
        const a = j * (SEG_U + 1) + i;
        const b = a + 1;
        const c = a + SEG_U + 1;
        const d = c + 1;
        idx[ii++] = a; idx[ii++] = c; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
      }
    }

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    return { posBuf, idxBuf, count: idx.length };
  }

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function createProgram(gl) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  function makeTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // 1x1 placeholder until the first video frame is available
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    return tex;
  }

  let styleAdded = false;
  function ensureStyles() {
    if (styleAdded) return;
    styleAdded = true;
    const st = document.createElement('style');
    st.textContent =
      '#rayneo-vr-btn{display:flex;align-items:center;justify-content:center;width:48px;color:#fff;opacity:.9}' +
      '#rayneo-vr-btn:hover{opacity:1}' +
      '#rayneo-vr-btn.rayneo-tracking{color:#f90;opacity:1;}' +
      '#rayneo-vr-btn.rayneo-tracking svg g{stroke:#f90;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ------------------------------------------------------- tracking mode
  // Drives YouTube's own spherical renderer (movie_player) from the IMU:
  // quaternion -> yaw/pitch (degrees) -> setSphericalProperties each frame.
  // No custom rendering; YouTube handles mesh/projection/stereo itself.

  const tracking = {
    active: false,
    raf: 0,
    qSmooth: null,   // smoothed orientation
    flipYaw: false,
    flipPitch: false,
    keyHandler: null,
    lastWarn: 0
  };

  function rotateVec(q, v) {
    // rotate vector v by quaternion q (standard q*v*q*)
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
      v[0] + qw * tx + (qy * tz - qz * ty),
      v[1] + qw * ty + (qz * tx - qx * tz),
      v[2] + qw * tz + (qx * ty - qy * tx)
    ];
  }

  function nlerp(a, b, t) {
    // shortest-path lerp + normalize
    const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    const s = dot < 0 ? -t : t;
    const bs = dot < 0 ? { x: -b.x, y: -b.y, z: -b.z, w: -b.w } : b;
    const r = {
      x: a.x * (1 - t) + bs.x * t,
      y: a.y * (1 - t) + bs.y * t,
      z: a.z * (1 - t) + bs.z * t,
      w: a.w * (1 - t) + bs.w * t
    };
    const len = Math.hypot(r.x, r.y, r.z, r.w) || 1;
    return { x: r.x / len, y: r.y / len, z: r.z / len, w: r.w / len };
  }

  function trackingFrame() {
    if (!tracking.active) return;
    tracking.raf = requestAnimationFrame(trackingFrame);

    // Stop when the user navigates away from a watch page
    if (!/^\/watch/.test(location.pathname)) { stopTracking(); return; }

    const q = getOrientation();
    if (!q) return;

    tracking.qSmooth = tracking.qSmooth ? nlerp(tracking.qSmooth, q, 0.35) : q;
    const qs = tracking.qSmooth;

    // Camera forward vector in world space (viewer looks along -z)
    const f = rotateVec(qs, [0, 0, -1]);
    const len = Math.hypot(f[0], f[1], f[2]) || 1;
    f[0] /= len; f[1] /= len; f[2] /= len;

    let yaw = Math.atan2(f[0], -f[2]) * 180 / Math.PI;
    let pitch = Math.asin(Math.max(-1, Math.min(1, -f[1]))) * 180 / Math.PI;
    // YouTube pans opposite to the natural convention; invert both so the
    // view follows the head direction.
    yaw = -yaw;
    pitch = -pitch;
    if (tracking.flipYaw) yaw = -yaw;
    if (tracking.flipPitch) pitch = -pitch;

    const player = document.getElementById('movie_player');
    if (player && typeof player.setSphericalProperties === 'function') {
      player.setSphericalProperties({ yaw, pitch });
    } else if (Date.now() - tracking.lastWarn > 5000) {
      tracking.lastWarn = Date.now();
      console.warn('[RayNeo YouTube tracking] movie_player API unavailable');
    }
  }

  function setButtonState() {
    const btn = document.getElementById('rayneo-vr-btn');
    if (btn) btn.classList.toggle('rayneo-tracking', tracking.active);
  }

  function startTracking() {
    if (tracking.active) return;
    tracking.active = true;
    tracking.flipYaw = localStorage.getItem('rayneo-yt-flip-yaw') === '1';
    tracking.flipPitch = localStorage.getItem('rayneo-yt-flip-pitch') === '1';
    tracking.qSmooth = null;

    tracking.keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); stopTracking(); return; }
      if (e.key === 'r' || e.key === 'R') {
        e.stopPropagation(); e.preventDefault();
        try { window.recenterRayNeo(); } catch (err) { /* noop */ }
      }
    };
    window.addEventListener('keydown', tracking.keyHandler, true);

    setButtonState();
    console.log('[RayNeo YouTube tracking] started - Esc stops, R recenters');
    tracking.raf = requestAnimationFrame(trackingFrame);
  }

  function stopTracking() {
    if (!tracking.active) return;
    tracking.active = false;
    cancelAnimationFrame(tracking.raf);
    if (tracking.keyHandler) window.removeEventListener('keydown', tracking.keyHandler, true);
    tracking.keyHandler = null;
    setButtonState();
    console.log('[RayNeo YouTube tracking] stopped');
  }

  function toggleTracking() {
    tracking.active ? stopTracking() : startTracking();
  }

  window.__rayneoYouTubeTracking = toggleTracking;
  window.__rayneoYouTubeFlip = function () {
    tracking.flipYaw = !tracking.flipYaw;
    localStorage.setItem('rayneo-yt-flip-yaw', tracking.flipYaw ? '1' : '0');
    console.log('[RayNeo YouTube tracking] flip yaw:', tracking.flipYaw);
  };
  window.__rayneoYouTubeFlipPitch = function () {
    tracking.flipPitch = !tracking.flipPitch;
    localStorage.setItem('rayneo-yt-flip-pitch', tracking.flipPitch ? '1' : '0');
    console.log('[RayNeo YouTube tracking] flip pitch:', tracking.flipPitch);
  };

  // ------------------------------------------------------------- overlay UI

  function buildOverlayUI() {
    const ui = document.createElement('div');
    ui.style.cssText =
      'position:fixed;top:0;right:0;z-index:' + (OVERLAY_Z + 1) +
      ';display:flex;gap:8px;padding:12px;';

    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.4);' +
        'border-radius:4px;padding:8px 14px;font:14px Roboto,Arial,sans-serif;cursor:pointer;';
      b.addEventListener('click', fn);
      ui.appendChild(b);
      return b;
    };

    mkBtn('Recenter', () => {
      try { window.recenterRayNeo(); } catch (e) { /* noop */ }
    });
    mkBtn('Mirror', () => toggleMirror());
    mkBtn('Exit VR', () => exitYouTubeVR());

    const status = document.createElement('div');
    status.id = 'rayneo-vr-status';
    status.style.cssText =
      'position:fixed;top:0;left:0;z-index:' + (OVERLAY_Z + 1) +
      ';color:#fff;background:rgba(0,0,0,.6);border-radius:4px;' +
      'padding:10px 14px;font:13px Roboto,Arial,sans-serif;max-width:60vw;';
    ui.appendChild(status);
    return { ui, status };
  }

  function updateStatus() {
    const el = document.getElementById('rayneo-vr-status');
    if (!el) return;
    const rayneo = (() => {
      try { return window.RayNeoWebXR && window.RayNeoWebXR.getRayneo(); } catch (e) { return null; }
    })();
    const connected = !!(rayneo && rayneo.connected);
    const modeNames = {
      '360mono': '360° mono',
      '360sbs': '360° stereo (SBS)',
      '180sbs': 'VR180 stereo (SBS)'
    };
    el.textContent = connected
      ? ('RayNeo VR · ' + (modeNames[state.mode] || state.mode) + ' · Esc exit · R recenter')
      : 'RayNeo VR · glasses NOT connected (run connect in extension popup) · Esc exit';
  }

  // ------------------------------------------------------------ enter/exit

  function findVideo() {
    return document.querySelector('video.html5-main-video') ||
      document.querySelector('video');
  }

  function enterYouTubeVR() {
    if (state.active) return;

    const video = findVideo();
    if (!video) {
      console.warn('[RayNeo YouTube VR] no <video> element found');
      return;
    }

    const info = getVRInfo();
    state.mode = (info && info.mode) || '360sbs';
    state.sbs = state.mode !== '360mono';
    console.log('[RayNeo YouTube VR] entering, mode:', state.mode,
      info ? '(detected: ' + info.projection + (info.stereo ? ', stereo' : '') + ')' : '(detection unavailable, defaulting to 360 SBS)');

    const canvas = document.createElement('canvas');
    canvas.id = 'rayneo-vr-canvas';
    canvas.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;z-index:' + OVERLAY_Z +
      ';background:#000;display:block;cursor:none;';
    document.documentElement.appendChild(canvas);

    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) {
      canvas.remove();
      console.error('[RayNeo YouTube VR] WebGL unavailable');
      return;
    }

    const prog = createProgram(gl);
    const geom = buildGeometry(gl, state.mode);
    const tex = makeTexture(gl);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aUV = gl.getAttribLocation(prog, 'aUV');
    const uVP = gl.getUniformLocation(prog, 'uVP');
    const uSbs = gl.getUniformLocation(prog, 'uSbs');
    const uEye = gl.getUniformLocation(prog, 'uEye');
    const uMirror = gl.getUniformLocation(prog, 'uMirror');

    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, geom.posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geom.idxBuf);

    const { ui, status } = buildOverlayUI();
    document.documentElement.appendChild(ui);

    Object.assign(state, {
      active: true, canvas, gl, program: prog, buffers: geom, texture: tex,
      video, ui, status, aPos, aUV, uVP, uSbs, uEye, uMirror, raf: 0
    });
    state.mirror = localStorage.getItem('rayneo-ytvr-mirror') === '1';
    updateStatus();

    // Overlay owns the keyboard while active: Esc exits, R recenters.
    state.keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); exitYouTubeVR(); return; }
      if (e.key === 'r' || e.key === 'R') {
        e.stopPropagation(); e.preventDefault();
        try { window.recenterRayNeo(); } catch (err) { /* noop */ }
      }
    };
    window.addEventListener('keydown', state.keyHandler, true);

    state.fsHandler = () => resize();
    window.addEventListener('resize', state.fsHandler);

    document.documentElement.requestFullscreen().catch(() => {});
    state.raf = requestAnimationFrame(frame);
  }

  function exitYouTubeVR() {
    if (!state.active) return;
    state.active = false;
    cancelAnimationFrame(state.raf);

    if (state.keyHandler) window.removeEventListener('keydown', state.keyHandler, true);
    if (state.fsHandler) window.removeEventListener('resize', state.fsHandler);

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    const { canvas, gl, texture, buffers, program, ui } = state;
    if (gl) {
      if (buffers) {
        gl.deleteBuffer(buffers.posBuf);
        gl.deleteBuffer(buffers.idxBuf);
      }
      if (texture) gl.deleteTexture(texture);
      if (program) gl.deleteProgram(program);
    }
    if (canvas) canvas.remove();
    if (ui) ui.remove();

    Object.assign(state, {
      canvas: null, gl: null, program: null, buffers: null, texture: null,
      video: null, ui: null, status: null, keyHandler: null, fsHandler: null
    });
    console.log('[RayNeo YouTube VR] exited');
  }

  function toggleMirror() {
    state.mirror = !state.mirror;
    localStorage.setItem('rayneo-ytvr-mirror', state.mirror ? '1' : '0');
    console.log('[RayNeo YouTube VR] mirror:', state.mirror);
    updateStatus();
  }

  // ---------------------------------------------------------------- render

  function resize() {
    if (!state.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (state.canvas.width !== w || state.canvas.height !== h) {
      state.canvas.width = w;
      state.canvas.height = h;
    }
  }

  function frame(timestamp) {
    if (!state.active) return;
    state.raf = requestAnimationFrame(frame);

    const gl = state.gl;
    const video = state.video;
    resize();

    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (e) { /* cross-origin or empty frame: keep last texture */ }
    }

    const q = getOrientation();
    const view = viewFromQuaternion(q);

    const w = state.canvas.width, h = state.canvas.height;
    const aspect = (w / 2) / h;
    const proj = perspective(DEFAULT_FOV * Math.PI / 180, aspect, 0.05, 50);
    const vp = mat4Mul(proj, view);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(state.program);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.uniform1f(state.uSbs, state.sbs ? 1 : 0);
    gl.uniform1f(state.uMirror, state.mirror ? 1 : 0);

    gl.uniformMatrix4fv(state.uVP, false, vp);
    gl.uniform1f(state.uEye, 0);
    gl.viewport(0, 0, w / 2, h);
    gl.drawElements(gl.TRIANGLES, state.buffers.count, gl.UNSIGNED_SHORT, 0);

    gl.uniform1f(state.uEye, 1);
    gl.viewport(w / 2, 0, w / 2, h);
    gl.drawElements(gl.TRIANGLES, state.buffers.count, gl.UNSIGNED_SHORT, 0);
  }

  // ------------------------------------------------------------- public API

  window.__rayneoYouTubeVR = function () {
    state.active ? exitYouTubeVR() : enterYouTubeVR();
  };

  window.__rayneoYouTubeVRInfo = function () {
    const info = getVRInfo();
    console.log('[RayNeo YouTube VR] detected:', info || 'not a VR video (or player API unavailable)');
    return info;
  };

  window.__rayneoYouTubeVRMirror = function () {
    toggleMirror();
  };

  // Poll for watch pages: YouTube is a SPA, so the button must be re-added
  // as the user navigates between videos.
  setInterval(ensureButton, 1500);

  console.log('[RayNeo YouTube VR] ready - VR videos get a "RayNeo VR" button; '
    + 'or run __rayneoYouTubeVR() in the console');
})();
