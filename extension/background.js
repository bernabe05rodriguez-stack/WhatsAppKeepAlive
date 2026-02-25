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
  lastAction: '',
  userCount: 0,
  currentChatPhone: null, // telefono del chat actualmente abierto en WA
};

// Track pending room requests so we can respond to popup
let pendingRoomsCallback = null;
let pendingJoinCallback = null;

// Message queue to avoid concurrent sends
let messageQueue = [];
let isSendingMessage = false;
let sendingSafetyTimer = null;
const SEND_SAFETY_TIMEOUT = 45000; // 45s max wait for content script response

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
      if (state.connected && state.roomId) {
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

// --- Send URL helper ---

function navigateToSendUrl(phone, message) {
  const sendUrl = 'https://web.whatsapp.com/send?phone=' + phone + '&text=' + encodeURIComponent(message);
  state.currentChatPhone = phone;
  chrome.tabs.update(state.waTabId, { url: sendUrl }).catch(() => {
    log('Failed to navigate WA tab');
    state.waTabId = null;
    state.currentChatPhone = null;
    wsSend({ type: 'message-sent', data: { success: false } });
    // Reset queue so next messages can proceed
    clearSafetyTimer();
    isSendingMessage = false;
    processMessageQueue();
  });
}

function clearSafetyTimer() {
  if (sendingSafetyTimer) {
    clearTimeout(sendingSafetyTimer);
    sendingSafetyTimer = null;
  }
}

function startSafetyTimer() {
  clearSafetyTimer();
  sendingSafetyTimer = setTimeout(() => {
    log('SAFETY TIMEOUT: no message-result received in', SEND_SAFETY_TIMEOUT, 'ms, resetting queue');
    sendingSafetyTimer = null;
    wsSend({ type: 'message-sent', data: { success: false } });
    isSendingMessage = false;
    processMessageQueue();
  }, SEND_SAFETY_TIMEOUT);
}

// --- Message Queue ---

function processMessageQueue() {
  if (isSendingMessage || messageQueue.length === 0) return;

  isSendingMessage = true;
  const data = messageQueue.shift();

  // Start safety timer to prevent permanent queue lock
  startSafetyTimer();

  state.lastAction = 'Enviando mensaje a +' + data.targetPhone + '...';
  notifyPopup({ type: 'state-update', data: getStateForPopup() });

  if (!state.waTabId) {
    log('No WA tab, cannot send message');
    wsSend({ type: 'message-sent', data: { success: false } });
    clearSafetyTimer();
    isSendingMessage = false;
    processMessageQueue(); // process next
    return;
  }

  const phone = data.targetPhone.replace(/[^0-9]/g, '');

  if (state.currentChatPhone === phone) {
    // Mismo chat ya abierto → escribir directo sin recargar
    log('Mismo chat abierto, enviando directo (type-and-send)');
    chrome.tabs.sendMessage(state.waTabId, {
      type: 'type-and-send',
      data: { message: data.message },
    }).catch(() => {
      // Content script no responde, caer a URL
      log('Content script no responde, cayendo a URL');
      state.currentChatPhone = null;
      navigateToSendUrl(phone, data.message);
    });
  } else {
    // Chat diferente → buscar en WA sin recargar (fallback a URL solo si no encuentra)
    log('Nuevo destino, intentando search-and-send');
    state.currentChatPhone = phone;
    chrome.tabs.sendMessage(state.waTabId, {
      type: 'search-and-send',
      data: { phone, message: data.message },
    }).catch(() => {
      // Content script no responde, caer a URL
      log('Content script no responde para search, cayendo a URL');
      navigateToSendUrl(phone, data.message);
    });
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
        state.userCount = data.userCount || 0;
        state.lastAction = 'Conectado a ' + state.roomName;
        saveState();
        openWATab();
        if (pendingJoinCallback) {
          pendingJoinCallback({ success: true, roomName: state.roomName, userCount: state.userCount });
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
      log('Send message request queued:', data.targetPhone);

      // Enqueue and process
      messageQueue.push(data);
      processMessageQueue();
      break;
    }

    case 'room-user-count': {
      const data = msg.data || {};
      if (data.roomId === state.roomId) {
        state.userCount = data.userCount || 0;
        notifyPopup({ type: 'state-update', data: getStateForPopup() });
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
    userCount: state.userCount,
  };
}

function autoLeaveRoom(reason) {
  if (!state.connected) {
    notifyPopup({ type: 'state-update', data: getStateForPopup() });
    return;
  }
  log('Auto-leaving room:', reason);
  wsSend({ type: 'leave', data: { roomId: state.roomId } });
  state.connected = false;
  state.roomId = '';
  state.roomName = '';
  state.roomPassword = '';
  state.lastAction = '';
  state.currentChatPhone = null;
  messageQueue = [];
  isSendingMessage = false;
  clearSafetyTimer();
  saveState();
  notifyPopup({ type: 'state-update', data: getStateForPopup() });
}

// --- WhatsApp Tab Management ---

function openWATab(url) {
  url = url || 'https://web.whatsapp.com';

  if (state.waTabId) {
    // Check if the tab still exists
    chrome.tabs.get(state.waTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        state.waTabId = null;
        findOrCreateWATab(url);
      } else {
        // Tab exists, update its URL if needed
        if (url !== 'https://web.whatsapp.com') {
          chrome.tabs.update(state.waTabId, { url });
        }
      }
    });
  } else {
    findOrCreateWATab(url);
  }
}

function findOrCreateWATab(url) {
  // Search for an existing WhatsApp Web tab before creating a new one
  chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
      createWATab(url);
    } else {
      // Use the first existing WA tab
      state.waTabId = tabs[0].id;
      log('Found existing WA tab:', state.waTabId);
      // Tab exists with WA loaded = assume logged in
      state.waLoggedIn = true;
      notifyPopup({ type: 'state-update', data: getStateForPopup() });
      if (url !== 'https://web.whatsapp.com') {
        chrome.tabs.update(state.waTabId, { url });
      }
    }
  });
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
    state.currentChatPhone = null;
    autoLeaveRoom('WA tab closed');
  }
});

// --- Handle messages from popup and content script ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log('Message received:', msg.type, sender.tab ? '(from tab ' + sender.tab.id + ')' : '(from popup)');

  switch (msg.type) {
    // --- From popup ---
    case 'get-state': {
      // Check if WA tab exists BEFORE responding
      chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => {
        if (tabs && tabs.length > 0) {
          state.waTabId = tabs[0].id;
          state.waLoggedIn = true;
        }
        sendResponse(getStateForPopup());
      });
      return true; // async response
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
      state.currentChatPhone = null;
      // Clear message queue and safety timer
      messageQueue = [];
      isSendingMessage = false;
      clearSafetyTimer();
      saveState();

      state.waTabId = null;
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
    case 'message-result': {
      const success = msg.success;
      log('Message result:', success);
      clearSafetyTimer();
      state.lastAction = success
        ? 'Mensaje enviado correctamente'
        : 'Error al enviar mensaje';
      wsSend({ type: 'message-sent', data: { success } });
      notifyPopup({ type: 'state-update', data: getStateForPopup() });
      // Unlock queue and process next message
      isSendingMessage = false;
      processMessageQueue();
      sendResponse({ ok: true });
      return false;
    }

    case 'wa-status': {
      // Capture tab ID from existing WA tab
      if (sender.tab && sender.tab.id) {
        if (!state.waTabId) {
          state.waTabId = sender.tab.id;
          log('Captured WA tab ID from content script:', state.waTabId);
        }
      }
      const status = msg.status;
      const wasLoggedIn = state.waLoggedIn;
      state.waLoggedIn = (status === 'ready');
      log('WA status:', status, '-> waLoggedIn:', state.waLoggedIn);
      // If session became unavailable while connected, auto-leave
      if (wasLoggedIn && !state.waLoggedIn && state.connected) {
        autoLeaveRoom('WA session lost');
      } else {
        notifyPopup({ type: 'state-update', data: getStateForPopup() });
      }
      sendResponse({ ok: true });
      return false;
    }

    default:
      log('Unknown message type:', msg.type);
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// --- Auto-update check ---

let knownExtVersion = null;

async function checkForExtUpdate() {
  if (!state.serverUrl) return;
  try {
    const resp = await fetch(state.serverUrl + '/api/ext-version');
    const data = await resp.json();
    if (knownExtVersion && data.version !== knownExtVersion) {
      log('Extension update detected! version:', knownExtVersion, '->', data.version, '- Reloading...');
      chrome.runtime.reload();
      return;
    }
    knownExtVersion = data.version;
  } catch (_) {
    // Server unreachable, skip
  }
}

// --- Keep-alive Alarm ---

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    log('Keepalive alarm fired');

    // Check for extension updates
    checkForExtUpdate();

    // If we should be connected but WS is dead, reconnect with jitter
    if (state.connected && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
      const jitter = Math.floor(Math.random() * 5000); // 0-5s random delay
      log('WS not connected, reconnecting in', jitter, 'ms (jitter)...');
      setTimeout(() => connectWS(), jitter);
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
    checkForExtUpdate(); // store initial version
  }
});

// Also handle service worker wakeup
(async () => {
  await loadState();
  if (state.serverUrl && state.connected) {
    log('Service worker woke up, reconnecting...');
    connectWS();
    checkForExtUpdate(); // store initial version
  }
})();
