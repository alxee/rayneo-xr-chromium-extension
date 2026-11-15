/**
 * RayNeo WebXR Extension - Background Service Worker
 * Manages WebHID connection state and communicates with content scripts
 */

// Extension state
let rayneoState = {
  connected: false,
  deviceInfo: null,
  enabled: true,
  lastOrientation: { w: 1, x: 0, y: 0, z: 0 }
};

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATE':
      sendResponse(rayneoState);
      break;

    case 'SET_ENABLED':
      rayneoState.enabled = message.enabled;
      chrome.storage.local.set({ enabled: message.enabled });
      broadcastToTabs({ type: 'STATE_CHANGED', state: rayneoState });
      sendResponse({ success: true });
      break;

    case 'DEVICE_CONNECTED':
      rayneoState.connected = true;
      rayneoState.deviceInfo = message.deviceInfo;
      broadcastToTabs({ type: 'STATE_CHANGED', state: rayneoState });
      sendResponse({ success: true });
      break;

    case 'DEVICE_DISCONNECTED':
      rayneoState.connected = false;
      rayneoState.deviceInfo = null;
      broadcastToTabs({ type: 'STATE_CHANGED', state: rayneoState });
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

  return true; // Keep channel open for async response
});

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

// Load saved settings on startup
chrome.storage.local.get(['enabled'], (result) => {
  if (result.enabled !== undefined) {
    rayneoState.enabled = result.enabled;
  }
});

// Handle extension icon click when popup is disabled
chrome.action.onClicked.addListener((tab) => {
  // Open popup or toggle state
});

console.log('RayNeo WebXR background service worker loaded');
