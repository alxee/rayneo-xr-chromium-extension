/**
 * RayNeo WebXR Extension - Popup Script
 * Handles UI interactions and communicates with background script
 */

// DOM elements
const enabledToggle = document.getElementById('enabled-toggle');
const connectionStatus = document.getElementById('connection-status');
const enabledStatus = document.getElementById('enabled-status');
const deviceInfo = document.getElementById('device-info');
const deviceName = document.getElementById('device-name');
const deviceId = document.getElementById('device-id');
const orientationDisplay = document.getElementById('orientation-display');
const orientationValues = document.getElementById('orientation-values');
const connectBtn = document.getElementById('connect-btn');
const recenterBtn = document.getElementById('recenter-btn');
const entervrBtn = document.getElementById('entervr-btn');
const yttrackBtn = document.getElementById('yttrack-btn');
const vrforceBtn = document.getElementById('vrforce-btn');
const webhidWarning = document.getElementById('webhid-warning');

// Check WebHID support
if (!('hid' in navigator)) {
  webhidWarning.classList.add('show');
  connectBtn.disabled = true;
}

// Update UI from state
function updateUI(state) {
  if (!state) return;

  // Update enabled toggle
  enabledToggle.checked = state.enabled;
  enabledStatus.textContent = state.enabled ? 'Enabled' : 'Disabled';
  enabledStatus.className = 'status-value ' + (state.enabled ? 'enabled' : 'disabled');

  // Update connection status
  connectionStatus.textContent = state.connected ? 'Connected' : 'Disconnected';
  connectionStatus.className = 'status-value ' + (state.connected ? 'connected' : 'disconnected');

  // Update device info
  if (state.connected && state.deviceInfo) {
    deviceInfo.style.display = 'block';
    deviceName.textContent = state.deviceInfo.model || state.deviceInfo.productName || 'RayNeo Glasses';
    deviceId.textContent = `VID: 0x${state.deviceInfo.vendorId.toString(16)} PID: 0x${state.deviceInfo.productId.toString(16)}`;
    connectBtn.textContent = 'Disconnect';
    recenterBtn.disabled = false;
    entervrBtn.disabled = false;
    yttrackBtn.disabled = false;
    orientationDisplay.style.display = 'block';
  } else {
    deviceInfo.style.display = 'none';
    connectBtn.textContent = 'Connect RayNeo Glasses';
    recenterBtn.disabled = true;
    entervrBtn.disabled = true;
    yttrackBtn.disabled = true;
    orientationDisplay.style.display = 'none';
  }

  // Update orientation if available
  if (state.lastOrientation) {
    const q = state.lastOrientation;
    orientationValues.textContent = `w:${q.w.toFixed(2)} x:${q.x.toFixed(2)} y:${q.y.toFixed(2)} z:${q.z.toFixed(2)}`;
  }
}

// Get current state
function refreshState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Error getting state:', chrome.runtime.lastError.message);
      return;
    }
    updateUI(response);
  });
}

// Initial state load
refreshState();

// Poll for orientation updates when connected
let orientationPollInterval = null;
function startOrientationPolling() {
  if (orientationPollInterval) return;
  orientationPollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_ORIENTATION' }, (orientation) => {
      if (chrome.runtime.lastError) {
        // Silently ignore polling errors
        return;
      }
      if (orientation) {
        const q = orientation;
        orientationValues.textContent = `w:${q.w.toFixed(2)} x:${q.x.toFixed(2)} y:${q.y.toFixed(2)} z:${q.z.toFixed(2)}`;
      }
    });
  }, 100);
}

function stopOrientationPolling() {
  if (orientationPollInterval) {
    clearInterval(orientationPollInterval);
    orientationPollInterval = null;
  }
}

// Check if we can send messages to a tab
function canMessageTab(tab) {
  if (!tab || !tab.url) return false;
  // Can't message chrome://, edge://, about:, extension pages, etc.
  const url = tab.url;
  return url.startsWith('http://') || url.startsWith('https://');
}

// Handle enabled toggle
enabledToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'SET_ENABLED',
    enabled: enabledToggle.checked
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Error setting enabled:', chrome.runtime.lastError.message);
    }
    refreshState();
  });
});

// Handle connect button
connectBtn.addEventListener('click', async () => {
  // We need to open a new tab to use WebHID because popups can't use it
  // Instead, send message to active tab to trigger connection
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!canMessageTab(tab)) {
    // Can't use WebHID on this page, open a helper page or show message
    connectBtn.textContent = 'Open a website first';
    setTimeout(() => {
      connectBtn.textContent = 'Connect RayNeo Glasses';
    }, 2000);
    return;
  }

  // Try to connect via content script
  chrome.tabs.sendMessage(tab.id, { type: 'CONNECT_REQUEST' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Content script not loaded on this page:', chrome.runtime.lastError.message);
      connectBtn.textContent = 'Reload page & retry';
      setTimeout(() => {
        connectBtn.textContent = 'Connect RayNeo Glasses';
      }, 2000);
      return;
    }

    // Show instructions to user
    connectBtn.textContent = 'Check page for connect dialog...';
    connectBtn.disabled = true;

    setTimeout(() => {
      refreshState();
      connectBtn.disabled = false;
    }, 2000);
  });
});

// Handle recenter button
recenterBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!canMessageTab(tab)) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'RECENTER_REQUEST' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Could not send recenter request:', chrome.runtime.lastError.message);
      return;
    }
    recenterBtn.textContent = 'Recentered!';
    setTimeout(() => {
      recenterBtn.textContent = 'Recenter View';
    }, 1000);
  });
});

// Handle Enter VR button (fires the player's own VR entry event, e.g. DeoVR)
entervrBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!canMessageTab(tab)) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'ENTERVR_REQUEST' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Could not send Enter VR request:', chrome.runtime.lastError.message);
      return;
    }
    entervrBtn.textContent = 'Sent!';
    setTimeout(() => {
      entervrBtn.textContent = 'Enter VR (player)';
    }, 1000);
  });
});

// Handle YouTube tracking button (toggle head tracking of YouTube's renderer)
yttrackBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!canMessageTab(tab)) {
    return;
  }

  const label = yttrackBtn.querySelector('span');
  chrome.tabs.sendMessage(tab.id, { type: 'YTTRACK_REQUEST' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Could not send YouTube tracking request:', chrome.runtime.lastError.message);
      return;
    }
    if (label) label.textContent = 'Toggled!';
    setTimeout(() => {
      if (label) label.textContent = 'YouTube tracking';
    }, 1000);
  });
});

// Handle VR mode button (toggle per-site "always offer VR" + reload)
vrforceBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!canMessageTab(tab)) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'VRFORCE_REQUEST' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Could not send VR mode request:', chrome.runtime.lastError.message);
      return;
    }
    // The page toggles its localStorage flag and reloads itself
  });
});

// Listen for state changes
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATE_CHANGED') {
    updateUI(message.state);

    if (message.state.connected) {
      startOrientationPolling();
    } else {
      stopOrientationPolling();
    }
  }
});

// Check if connected and start polling
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (chrome.runtime.lastError) {
    return;
  }
  if (state && state.connected) {
    startOrientationPolling();
  }
});
