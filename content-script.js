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
});

console.log('RayNeo WebXR content script loaded');
