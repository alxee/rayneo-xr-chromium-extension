/**
 * RayNeo WebXR Extension - Content Script
 * Injects WebXR polyfill into pages
 */

// Helper to safely send messages to background script
// Handles "Extension context invalidated" errors gracefully
function safeSendMessage(message, callback) {
  try {
    if (!chrome.runtime?.id) {
      // Extension context is invalid
      return;
    }
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        // Silently ignore - extension may have been reloaded
        return;
      }
      if (callback) callback(response);
    });
  } catch (e) {
    // Extension context invalidated - silently ignore
  }
}

// Inject the polyfill script into the page context
// NOTE: the polyfill is now injected statically via a MAIN-world content script
// (injected-bundle.js, see manifest.json) because pages with a strict CSP
// (YouTube, etc.) block script tags with chrome-extension:// URLs.
function injectScript(file) {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(file);
    script.type = 'module';
    script.onload = function() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    // Extension context may be invalid
  }
}

// Check if extension is enabled before injecting
safeSendMessage({ type: 'GET_STATE' }, (state) => {
  // Forward initial enabled state to the MAIN-world polyfill so the toggle
  // is respected even though the bundle is injected statically
  if (state) {
    window.postMessage({ type: 'RAYNEO_STATE_CHANGED', state }, '*');
  }
});

// Tell the background a fresh document loaded in this tab: any XR session the
// previous document had is gone (reload / navigation), so the tab no longer
// counts as "presenting VR" for the close-the-tab display restore. Top frame
// only - iframes (ads etc.) load and unload independently of the tab.
if (window === window.top) {
  safeSendMessage({ type: 'VR_PAGE_LOADED' });
}

// Helper to safely call sendResponse
function safeSendResponse(sendResponse, data) {
  try {
    if (chrome.runtime?.id) {
      sendResponse(data);
    }
  } catch (e) {
    // Extension context invalidated - silently ignore
  }
}

// Read the per-site "VR mode" flag. Content scripts share the page's
// localStorage (same origin), so we can read the flag written by the
// MAIN-world polyfill directly.
function getVRForceEnabled() {
  try {
    return localStorage.getItem('rayneo-vr-force') === '1';
  } catch (e) {
    return false;
  }
}

// Listen for state changes from background
try {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      return;
    }

    try {
      if (message.type === 'STATE_CHANGED') {
        // Forward state to page context
        window.postMessage({
          type: 'RAYNEO_STATE_CHANGED',
          state: message.state
        }, '*');
      }

      if (message.type === 'CONNECT_REQUEST') {
        // Forward to page context to trigger WebHID connection
        window.postMessage({ type: 'RAYNEO_CONNECT_REQUEST' }, '*');
        safeSendResponse(sendResponse, { success: true });
      }

      if (message.type === 'RECENTER_REQUEST') {
        // Forward to page context to recenter
        window.postMessage({ type: 'RAYNEO_RECENTER_REQUEST' }, '*');
        safeSendResponse(sendResponse, { success: true });
      }

      if (message.type === 'ENTERVR_REQUEST') {
        // Forward to page context to trigger the player's own "Enter VR"
        window.postMessage({ type: 'RAYNEO_ENTERVR_REQUEST' }, '*');
        safeSendResponse(sendResponse, { success: true });
      }

      if (message.type === 'YTTRACK_REQUEST') {
        // Forward to page context to toggle YouTube head tracking
        window.postMessage({ type: 'RAYNEO_YTTRACK_REQUEST' }, '*');
        safeSendResponse(sendResponse, { success: true });
      }

      if (message.type === 'VRFORCE_REQUEST') {
        // Forward to page context to toggle per-site VR mode (reload follows)
        window.postMessage({ type: 'RAYNEO_VRFORCE_REQUEST' }, '*');
        safeSendResponse(sendResponse, { success: true });
      }

      if (message.type === 'VRFORCE_GET_STATE') {
        // Report the real per-site VR mode state to the popup toggle
        safeSendResponse(sendResponse, { enabled: getVRForceEnabled() });
      }

      if (message.type === 'VRFORCE_SET_REQUEST') {
        // Set the per-site VR mode flag explicitly (popup toggle sends the
        // desired state), then reload so the site re-runs its VR detection
        try {
          localStorage.setItem('rayneo-vr-force', message.enabled ? '1' : '0');
        } catch (e) {
          safeSendResponse(sendResponse, { success: false });
          return;
        }
        safeSendResponse(sendResponse, { success: true, enabled: !!message.enabled });
        setTimeout(() => {
          try { location.reload(); } catch (e) { /* noop */ }
        }, 400);
      }

      if (message.type === 'GET_DEVICE_STATE') {
        // Ask the MAIN-world driver for the page's real connection state (the
        // background service worker can lose its in-memory state between
        // restarts, so the popup reconciles against live pages)
        window.postMessage({ type: 'RAYNEO_GET_DEVICE_STATE' }, '*');
      }

      if (message.type === 'RESTORE_2D_REQUEST') {
        // The tab that presented VR content was closed: switch the glasses
        // back to 2D if this page can (same origin = same WebHID grant)
        window.postMessage({ type: 'RAYNEO_RESTORE_2D_REQUEST' }, '*');
      }
    } catch (e) {
      // Extension context invalidated during message handling
    }

    return true;
  });
} catch (e) {
  // Extension context may be invalid
}

// Bridge between page context and background script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  const data = event.data;

  if (data.type === 'RAYNEO_GET_STATE') {
    safeSendMessage({ type: 'GET_STATE' }, (state) => {
      window.postMessage({ type: 'RAYNEO_STATE_RESPONSE', state }, '*');
    });
  }

  if (data.type === 'RAYNEO_ORIENTATION_UPDATE') {
    safeSendMessage({
      type: 'ORIENTATION_UPDATE',
      orientation: data.orientation
    });
  }

  if (data.type === 'RAYNEO_DEVICE_CONNECTED') {
    safeSendMessage({
      type: 'DEVICE_CONNECTED',
      deviceInfo: data.deviceInfo
    });
  }

  if (data.type === 'RAYNEO_DEVICE_DISCONNECTED') {
    safeSendMessage({ type: 'DEVICE_DISCONNECTED' });
  }

  if (data.type === 'RAYNEO_VR_SESSION_STARTED') {
    // Register this tab with the background: it is presenting VR content
    safeSendMessage({ type: 'VR_SESSION_STARTED' });
  }

  if (data.type === 'RAYNEO_VR_SESSION_ENDED') {
    // Session ended normally (panel back in 2D) - stop watching this tab
    safeSendMessage({ type: 'VR_SESSION_ENDED' });
  }

  if (data.type === 'RAYNEO_RESTORE_2D_RESULT') {
    safeSendMessage({ type: 'RESTORE_2D_RESULT', success: !!data.success });
  }

  if (data.type === 'RAYNEO_DEVICE_STATE_RESPONSE') {
    safeSendMessage({
      type: 'DEVICE_STATE_FROM_PAGE',
      connected: !!data.connected,
      deviceInfo: data.deviceInfo || null
    });
  }

  if (data.type === 'RAYNEO_GET_VR_STATUS') {
    safeSendMessage({ type: 'GET_VR_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      window.postMessage({
        type: 'RAYNEO_VR_STATUS_RESPONSE',
        active: !!response.active
      }, '*');
    });
  }
});

console.log('RayNeo WebXR content script loaded');
