/**
 * RayNeo WebXR Extension - Background Service Worker
 * Manages WebHID connection state and communicates with content scripts
 */

// Extension state
let rayneoState = {
  connected: false,
  deviceInfo: null,
  enabled: true,
  autoModeSwitch: true,
  lastOrientation: { w: 1, x: 0, y: 0, z: 0 }
};

// Tabs currently presenting VR content on the glasses (SBS mode active):
// tabId -> origin. If such a tab is closed, its XR session dies without
// end() running, so the extension must switch the glasses back to 2D.
let vrTabs = new Map();

// Warn timer for the tab-close restore (see requestRestore2D)
let restore2dWarnTimer = null;

// Persist vrTabs across service-worker restarts (Chrome stops MV3 workers
// after ~30 s of inactivity)
function saveVrTabs() {
  try {
    chrome.storage.session.set({ vrTabs: [...vrTabs.entries()] }).catch(() => {});
  } catch (e) { /* storage.session not available on older Chrome */ }
}

// Persisted state is loaded asynchronously when the (re)started service
// worker spins up - messages that arrive before the load completes must NOT
// be answered from the in-memory defaults, or the popup shows the toggles
// back at their defaults and pages act on the wrong flags. Every handler
// awaits this first.
let stateLoaded = Promise.all([
  new Promise((resolve) => {
    chrome.storage.local.get(['enabled', 'autoModeSwitch'], (result) => {
      if (result.enabled !== undefined) {
        rayneoState.enabled = result.enabled;
      }
      if (result.autoModeSwitch !== undefined) {
        rayneoState.autoModeSwitch = result.autoModeSwitch;
      }
      resolve();
    });
  }),
  new Promise((resolve) => {
    try {
      chrome.storage.session.get('vrTabs', (result) => {
        if (Array.isArray(result.vrTabs)) {
          vrTabs = new Map(result.vrTabs);
        }
        resolve();
      });
    } catch (e) {
      resolve(); // storage.session not available on older Chrome
    }
  })
]);

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Respond only after persisted state finished loading (see stateLoaded)
  stateLoaded.then(() => {
    switch (message.type) {
    case 'GET_STATE':
      sendResponse(rayneoState);
      break;

    case 'GET_VR_STATUS':
      // Is any tab currently presenting VR content (SBS on the glasses)?
      sendResponse({ active: vrTabs.size > 0 });
      break;

    case 'SET_ENABLED':
      rayneoState.enabled = message.enabled;
      chrome.storage.local.set({ enabled: message.enabled });
      broadcastState();
      sendResponse({ success: true });
      break;

    case 'SET_AUTO_MODE_SWITCH':
      rayneoState.autoModeSwitch = message.enabled;
      chrome.storage.local.set({ autoModeSwitch: message.enabled });
      broadcastState();
      sendResponse({ success: true });
      break;

    case 'DEVICE_CONNECTED':
      rayneoState.connected = true;
      rayneoState.deviceInfo = message.deviceInfo;
      broadcastState();
      sendResponse({ success: true });
      break;

    case 'DEVICE_DISCONNECTED':
      rayneoState.connected = false;
      rayneoState.deviceInfo = null;
      broadcastState();
      sendResponse({ success: true });
      break;

    case 'DEVICE_STATE_FROM_PAGE':
      // Ground truth from a live page: the in-memory state can be stale after
      // a service-worker restart, so reconcile the connection status. The
      // popup asks the active tab on open and the result reaches it through
      // the STATE_CHANGED broadcast.
      if (!!message.connected !== rayneoState.connected) {
        rayneoState.connected = !!message.connected;
        rayneoState.deviceInfo = message.connected ? (message.deviceInfo || null) : null;
        broadcastState();
      }
      sendResponse({ success: true });
      break;

    case 'VR_SESSION_STARTED':
      // A page entered an immersive session and switched the glasses to SBS
      if (sender.tab && sender.tab.id !== undefined) {
        vrTabs.set(sender.tab.id, sender.origin || null);
        saveVrTabs();
      }
      sendResponse({ success: true });
      break;

    case 'VR_SESSION_ENDED':
      // Session ended normally: the panel is back in 2D
      if (sender.tab && vrTabs.delete(sender.tab.id)) {
        saveVrTabs();
      }
      sendResponse({ success: true });
      break;

    case 'VR_PAGE_LOADED':
      // A fresh document replaced the tab's page (reload / navigation): any
      // session the previous document had is gone, so stop treating this tab
      // as presenting VR. Sent by the top frame only.
      if (sender.tab && vrTabs.delete(sender.tab.id)) {
        saveVrTabs();
      }
      sendResponse({ success: true });
      break;

    case 'RESTORE_2D_RESULT':
      // A tab switched the glasses back to 2D - cancel the failure warning
      if (message.success && restore2dWarnTimer) {
        clearTimeout(restore2dWarnTimer);
        restore2dWarnTimer = null;
      }
      sendResponse({ success: true });
      break;

    case 'ORIENTATION_UPDATE':
      rayneoState.lastOrientation = message.orientation;
      // Don't broadcast every orientation update - let content scripts poll
      sendResponse({ success: true });
      break;

    case 'GET_ORIENTATION':
      sendResponse(rayneoState.lastOrientation);
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
    }
  });

  return true; // Keep channel open for async response
});

// Broadcast the full state to all tabs and to the extension's own pages
// (the popup listens on the runtime channel; tabs need per-tab messages -
// chrome.tabs.sendMessage never reaches the popup)
function broadcastState() {
  const message = { type: 'STATE_CHANGED', state: rayneoState };
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // No extension page is open (popup closed) - nothing to update
    });
  } catch (e) { /* ignore */ }
  broadcastToTabs(message);
}

// Broadcast message to all tabs
function broadcastToTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab might not have content script loaded
      });
    });
  });
}

// The tab that presented VR content was closed: its XR session is destroyed
// without end() running, leaving the glasses in side-by-side (SBS) mode. Ask
// all remaining tabs to restore 2D - a tab on the same origin as the closed
// one holds the persistent WebHID grant and can reopen the device and send
// the 2D command.
chrome.tabs.onRemoved.addListener((tabId) => {
  stateLoaded.then(() => {
    if (!vrTabs.has(tabId)) return;
    vrTabs.delete(tabId);
    saveVrTabs();
    // "Auto mode switch" off: the user manages the panel mode, don't touch it
    if (rayneoState.autoModeSwitch === false) return;
    console.log('RayNeo: tab presenting VR content was closed - restoring normal 2D mode');
    requestRestore2D();
  });
});

function requestRestore2D() {
  broadcastToTabs({ type: 'RESTORE_2D_REQUEST' });
  // If no tab could restore (e.g. the VR site's only tab was closed), say so:
  // the glasses stay in SBS until a page on that site is opened again (fresh
  // connections reset the display when no VR is active) or they are unplugged.
  if (restore2dWarnTimer) clearTimeout(restore2dWarnTimer);
  restore2dWarnTimer = setTimeout(() => {
    restore2dWarnTimer = null;
    console.warn('RayNeo: could not restore 2D automatically - the glasses are still in ' +
      'side-by-side mode. Open the VR site again or unplug and replug the glasses.');
  }, 5000);
}

// Handle extension icon click when popup is disabled
chrome.action.onClicked.addListener((tab) => {
  // Open popup or toggle state
});

console.log('RayNeo WebXR background service worker loaded');
