// background.js - WhatsApp KeepAlive Service Worker

'use strict';

// URL por defecto del servidor
const DEFAULT_SERVER = 'https://redhawk-whatsapp-keepalive.bm6z1s.easypanel.host';

// --- State ---
let state = {
  serverUrl: DEFAULT_SERVER,
  phone: '',
  roomId: '',
  roomName: '',
  roomPassword: '',
  connected: false,
  waTabId: null,
  waLoggedIn: false,
  ws: null,
  pendingMessage: null, // { targetPhone, message }
  lastAction: '',
};

// Track pending room requests so we can respond to popup
let pendingRoomsCallback = null;
let pendingJoinCallback = null;

// --- Logging ---
function log(...args) {
  console.log('[WKA-BG]', ...args);
}

// --- Persistence ---

async function saveState() {
  try {
    await chrome.storage.local.set({
      serverUrl: state.serverUrl,
      phone: state.phone,
      roomId: state.roomId,
      roomName: state.roomName,
      roomPassword: state.roomPassword,
      connected: state.connected,
    });
  } catch (e) {
    log('Error saving state:', e);
  }
}

async function loadState() {
  try {
    const stored = await chrome.storage.local.get([
      'serverUrl', 'phone', 'roomId', 'roomName', 'roomPassword', 'connected',
    ]);
    state.serverUrl = stored.serverUrl || '';
    state.phone = stored.phone || '';
    state.roomPassword = stored.roomPassword || '';
    state.roomId = stored.roomId || '';
    state.roomName = stored.roomName || '';
    state.connected = stored.connected || false;
    log('State loaded:', { serverUrl: state.serverUrl, phone: state.phone, roomId: state.roomId, connected: state.connected });
  } catch (e) {
    log('Error loading state:', e);
  }
}

// --- WebSocket Management ---

function connectWS() {
  if (!state.serverUrl) {
    log('No server URL, skipping WS connect');
    return;
  }

  // Close existing connection if any
  if (state.ws) {
    try {
      state.ws.close();
    } catch (_) { /* ignore */ }
    state.ws = null;
  }

  const wsUrl = state.serverUrl.replace(/^http/, 'ws') + '/ws/ext';
  log('Connecting WebSocket to:', wsUrl);

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      log('WebSocket connected');
      state.ws = ws;

      // Re-join room if we were connected (include password for auth)
      if (state.connected && state.roomId && state.roomPassword) {
        log('Re-joining room:', state.roomId);
        wsSend({
          type: 'join',
          data: { phone: state.phone, roomId: state.roomId, password: state.roomPassword },
        });
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        log('Error parsing WS message:', e);
      }
    };

    ws.onclose = (event) => {
      log('WebSocket closed:', event.code, event.reason);
      state.ws = null;
      // Reconnect will happen on next alarm
    };

    ws.onerror = (error) => {
      log('WebSocket error:', error);
      state.ws = null;
    };
  } catch (e) {
    log('Error creating WebSocket:', e);
    state.ws = null;
  }
}

function wsSend(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    log('WS sent:', msg.type);
    return true;
  }
  log('WS not connected, cannot send:', msg.type);
  return false;
}

function ensureWS() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    connectWS();
  }
}

// --- Handle messages from server ---

function handleServerMessage(msg) {
  log('Server message:', msg.type);

  switch (msg.type) {
    case 'rooms': {
      const rooms = msg.data || [];
      // Forward to popup if there's a pending callback
      if (pendingRoomsCallback) {
        pendingRoomsCallback({ rooms });
        pendingRoomsCallback = null;
      }
      // Also broadcast to popup in case it's listening
      notifyPopup({ type: 'rooms-update', data: { rooms } });
      break;
    }

    case 'joined': {
      const data = msg.data || {};
      if (data.success) {
        state.connected = true;
        state.roomName = data.roomName || state.roomName;
        state.lastAction = 'Conectado a ' + state.roomName;
        saveState();
        openWATab();
        // Activar overlay en la pestaña de WhatsApp
        activateContentScript();
        if (pendingJoinCallback) {
          pendingJoinCallback({ success: true, roomName: state.roomName });
          pendingJoinCallback = null;
        }
      } else {
        if (pendingJoinCallback) {
          pendingJoinCallback({ success: false, error: data.error || 'Error al unirse' });
          pendingJoinCallback = null;
        }
      }
      notifyPopup({
        type: 'state-update',
        data: getStateForPopup(),
      });
      break;
    }

    case 'send-message': {
      const data = msg.data || {};
      log('Send message request:', data.targetPhone);
      state.pendingMessage = {
        targetPhone: data.targetPhone,
        message: data.message,
      };
      state.lastAction = 'Enviando mensaje a +' + data.targetPhone + '...';
      notifyPopup({ type: 'state-update', data: getStateForPopup() });

      // Navigate WA tab to the send URL
      if (state.waTabId) {
        const url = 'https://web.whatsapp.com/send?phone=' + encodeURIComponent(data.targetPhone);
        chrome.tabs.update(state.waTabId, { url }, () => {
          if (chrome.runtime.lastError) {
            log('Error updating WA tab:', chrome.runtime.lastError.message);
            // Tab might have been closed
            state.waTabId = null;
            openWATab(url);
          }
        });
      } else {
        const url = 'https://web.whatsapp.com/send?phone=' + encodeURIComponent(data.targetPhone);
        openWATab(url);
      }
      break;
    }

    case 'pong':
      // Ignore
      break;

    case 'error': {
      const data = msg.data || {};
      log('Server error:', data.message);
      notifyPopup({ type: 'state-update', data: getStateForPopup() });
      if (pendingRoomsCallback) {
        pendingRoomsCallback({ error: data.message });
        pendingRoomsCallback = null;
      }
      if (pendingJoinCallback) {
        pendingJoinCallback({ success: false, error: data.message });
        pendingJoinCallback = null;
      }
      break;
    }

    default:
      log('Unknown server message type:', msg.type);
  }
}

// --- Notify popup ---

function notifyPopup(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Popup not open, ignore
    });
  } catch (_) {
    // Ignore - popup might not be open
  }
}

function getStateForPopup() {
  return {
    connected: state.connected,
    serverUrl: state.serverUrl,
    phone: state.phone,
    roomId: state.roomId,
    roomName: state.roomName,
    waLoggedIn: state.waLoggedIn,
    lastAction: state.lastAction,
  };
}

// --- Content Script Control ---

function activateContentScript() {
  if (state.waTabId) {
    chrome.tabs.sendMessage(state.waTabId, { type: 'activate' }).catch(() => {});
  }
}

function deactivateContentScript() {
  if (state.waTabId) {
    chrome.tabs.sendMessage(state.waTabId, { type: 'deactivate' }).catch(() => {});
  }
}

// --- WhatsApp Tab Management ---

function openWATab(url) {
  url = url || 'https://web.whatsapp.com';

  if (state.waTabId) {
    // Check if the tab still exists
    chrome.tabs.get(state.waTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        state.waTabId = null;
        createWATab(url);
      } else {
        // Tab exists, update its URL if needed
        if (url !== 'https://web.whatsapp.com') {
          chrome.tabs.update(state.waTabId, { url });
        }
      }
    });
  } else {
    createWATab(url);
  }
}

function createWATab(url) {
  chrome.tabs.create({ url, active: false }, (tab) => {
    if (chrome.runtime.lastError) {
      log('Error creating WA tab:', chrome.runtime.lastError.message);
      return;
    }
    state.waTabId = tab.id;
    log('WA tab created:', tab.id);
  });
}

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.waTabId) {
    log('WA tab was closed');
    state.waTabId = null;
    state.waLoggedIn = false;
    notifyPopup({ type: 'state-update', data: getStateForPopup() });
  }
});

// --- Handle messages from popup and content script ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log('Message received:', msg.type, sender.tab ? '(from tab ' + sender.tab.id + ')' : '(from popup)');

  switch (msg.type) {
    // --- From popup ---
    case 'get-state': {
      sendResponse(getStateForPopup());
      return false;
    }

    case 'set-config': {
      const data = msg.data || {};
      state.serverUrl = data.serverUrl || state.serverUrl;
      state.phone = data.phone || state.phone;
      saveState();
      ensureWS();
      sendResponse({ ok: true });
      return false;
    }

    case 'get-rooms': {
      ensureWS();
      // Wait for WS connection if not ready, then request rooms
      const requestRooms = () => {
        const sent = wsSend({ type: 'get-rooms' });
        if (!sent) {
          sendResponse({ error: 'No se pudo conectar al servidor' });
          return;
        }
        // Store callback for when server responds
        pendingRoomsCallback = (result) => {
          sendResponse(result);
        };
      };

      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        requestRooms();
      } else {
        // Wait a bit for connection
        setTimeout(() => {
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            requestRooms();
          } else {
            sendResponse({ error: 'No se pudo conectar al servidor. Verifica la URL.' });
          }
        }, 3000);
      }
      return true; // Keep channel open for async response
    }

    case 'join': {
      const data = msg.data || {};
      state.roomId = data.roomId;
      state.roomPassword = data.password || '';
      ensureWS();

      const doJoin = () => {
        const sent = wsSend({
          type: 'join',
          data: {
            phone: state.phone,
            roomId: data.roomId,
            password: data.password,
          },
        });
        if (!sent) {
          sendResponse({ success: false, error: 'No se pudo conectar al servidor' });
          return;
        }
        pendingJoinCallback = (result) => {
          sendResponse(result);
        };
      };

      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        doJoin();
      } else {
        setTimeout(() => {
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            doJoin();
          } else {
            sendResponse({ success: false, error: 'No se pudo conectar al servidor' });
          }
        }, 3000);
      }
      return true; // Keep channel open for async response
    }

    case 'leave': {
      wsSend({ type: 'leave', data: { roomId: state.roomId } });
      state.connected = false;
      state.roomId = '';
      state.roomName = '';
      state.roomPassword = '';
      state.lastAction = '';
      state.pendingMessage = null;
      saveState();

      // Deactivate overlay and close WA tab
      deactivateContentScript();
      if (state.waTabId) {
        chrome.tabs.remove(state.waTabId).catch(() => {});
        state.waTabId = null;
      }
      state.waLoggedIn = false;

      sendResponse({ ok: true });
      return false;
    }

    case 'open-wa': {
      openWATab();
      sendResponse({ ok: true });
      return false;
    }

    // --- From content script ---
    case 'get-pending': {
      const pending = state.pendingMessage;
      state.pendingMessage = null;
      sendResponse(pending || {});
      return false;
    }

    case 'message-result': {
      const success = msg.success;
      log('Message result:', success);
      state.lastAction = success
        ? 'Mensaje enviado correctamente'
        : 'Error al enviar mensaje';
      wsSend({ type: 'message-sent', data: { success } });
      notifyPopup({ type: 'state-update', data: getStateForPopup() });
      sendResponse({ ok: true });
      return false;
    }

    case 'wa-status': {
      const status = msg.status;
      state.waLoggedIn = (status === 'ready');
      log('WA status:', status, '-> waLoggedIn:', state.waLoggedIn);
      notifyPopup({ type: 'state-update', data: getStateForPopup() });
      sendResponse({ ok: true });
      return false;
    }

    default:
      log('Unknown message type:', msg.type);
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// --- Keep-alive Alarm ---

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    log('Keepalive alarm fired');

    // If we should be connected but WS is dead, reconnect
    if (state.connected && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
      log('WS not connected, reconnecting...');
      connectWS();
    }

    // Send ping if connected
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'ping' });
    }
  }
});

// --- Startup ---

chrome.runtime.onInstalled.addListener(async () => {
  log('Extension installed/updated');
  await loadState();
  if (state.serverUrl) {
    connectWS();
  }
});

// Also handle service worker wakeup
(async () => {
  await loadState();
  if (state.serverUrl && state.connected) {
    log('Service worker woke up, reconnecting...');
    connectWS();
  }
})();
