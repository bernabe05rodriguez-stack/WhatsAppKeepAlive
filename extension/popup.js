// popup.js - WhatsApp KeepAlive Extension Popup

(function () {
  'use strict';

  // --- DOM References ---
  const steps = {
    config:    document.getElementById('step-config'),
    rooms:     document.getElementById('step-rooms'),
    password:  document.getElementById('step-password'),
    connected: document.getElementById('step-connected'),
  };

  const els = {
    // Step 1
    inputServer:   document.getElementById('input-server'),
    inputPhone:    document.getElementById('input-phone'),
    btnContinue:   document.getElementById('btn-continue'),
    // Step 2
    btnBackRooms:  document.getElementById('btn-back-rooms'),
    roomsLoading:  document.getElementById('rooms-loading'),
    roomsList:     document.getElementById('rooms-list'),
    roomsError:    document.getElementById('rooms-error'),
    // Step 3
    btnBackPassword: document.getElementById('btn-back-password'),
    passwordTitle:   document.getElementById('password-title'),
    inputPassword:   document.getElementById('input-password'),
    btnJoin:         document.getElementById('btn-join'),
    passwordError:   document.getElementById('password-error'),
    // Step 4
    connectedRoomName: document.getElementById('connected-room-name'),
    waStatusOk:        document.getElementById('wa-status-ok'),
    waStatusWarn:       document.getElementById('wa-status-warn'),
    btnOpenWa:         document.getElementById('btn-open-wa'),
    lastAction:        document.getElementById('last-action'),
    btnLeave:          document.getElementById('btn-leave'),
  };

  // --- State ---
  let selectedRoom = { id: '', name: '' };

  // --- Helpers ---

  function showStep(name) {
    Object.values(steps).forEach(s => s.classList.remove('active'));
    if (steps[name]) {
      steps[name].classList.add('active');
    }
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function hideError(el) {
    el.textContent = '';
    el.classList.add('hidden');
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response);
      });
    });
  }

  // --- Init ---

  async function init() {
    // Load saved config
    const stored = await chrome.storage.local.get(['serverUrl', 'phone', 'roomId', 'roomName']);

    if (stored.serverUrl) els.inputServer.value = stored.serverUrl;
    if (stored.phone) els.inputPhone.value = stored.phone;

    // Get current state from background
    const state = await sendMsg({ type: 'get-state' });

    if (state && state.connected) {
      selectedRoom.id = state.roomId || stored.roomId || '';
      selectedRoom.name = state.roomName || stored.roomName || '';
      showConnectedView(state);
      showStep('connected');
    } else if (stored.serverUrl && stored.phone) {
      showStep('rooms');
      fetchRooms();
    } else {
      showStep('config');
    }
  }

  // --- Step 1: Config ---

  els.btnContinue.addEventListener('click', async () => {
    const serverUrl = els.inputServer.value.trim().replace(/\/+$/, '');
    const phone = els.inputPhone.value.trim();

    if (!serverUrl) {
      els.inputServer.focus();
      return;
    }
    if (!phone) {
      els.inputPhone.focus();
      return;
    }

    els.btnContinue.disabled = true;

    await chrome.storage.local.set({ serverUrl, phone });
    await sendMsg({ type: 'set-config', data: { serverUrl, phone } });

    els.btnContinue.disabled = false;
    showStep('rooms');
    fetchRooms();
  });

  // --- Step 2: Rooms ---

  els.btnBackRooms.addEventListener('click', () => {
    showStep('config');
  });

  async function fetchRooms() {
    els.roomsLoading.classList.remove('hidden');
    els.roomsList.innerHTML = '';
    hideError(els.roomsError);

    const response = await sendMsg({ type: 'get-rooms' });

    els.roomsLoading.classList.add('hidden');

    if (!response || response.error) {
      showError(els.roomsError, response?.error || 'No se pudo conectar al servidor');
      return;
    }

    if (response.rooms && response.rooms.length > 0) {
      renderRooms(response.rooms);
    } else {
      showError(els.roomsError, 'No hay salas disponibles');
    }
  }

  function renderRooms(rooms) {
    els.roomsList.innerHTML = '';
    rooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = 'room-card';
      card.textContent = room.name || room.id;
      card.addEventListener('click', () => {
        selectedRoom.id = room.id;
        selectedRoom.name = room.name || room.id;
        els.passwordTitle.textContent = 'Contrasena de ' + selectedRoom.name;
        els.inputPassword.value = '';
        hideError(els.passwordError);
        showStep('password');
      });
      els.roomsList.appendChild(card);
    });
  }

  // --- Step 3: Password ---

  els.btnBackPassword.addEventListener('click', () => {
    showStep('rooms');
  });

  els.btnJoin.addEventListener('click', async () => {
    const password = els.inputPassword.value;

    if (!password) {
      els.inputPassword.focus();
      return;
    }

    els.btnJoin.disabled = true;
    hideError(els.passwordError);

    const response = await sendMsg({
      type: 'join',
      data: { roomId: selectedRoom.id, password },
    });

    els.btnJoin.disabled = false;

    if (response && response.success) {
      await chrome.storage.local.set({
        roomId: selectedRoom.id,
        roomName: selectedRoom.name,
      });
      showConnectedView(response);
      showStep('connected');
    } else {
      showError(els.passwordError, response?.error || 'No se pudo unir a la sala');
    }
  });

  // --- Step 4: Connected ---

  function showConnectedView(state) {
    els.connectedRoomName.textContent = selectedRoom.name || state?.roomName || 'Sala';
    updateWaStatus(state?.waLoggedIn || false);
    if (state?.lastAction) {
      els.lastAction.textContent = state.lastAction;
    } else {
      els.lastAction.textContent = '';
    }
  }

  function updateWaStatus(loggedIn) {
    if (loggedIn) {
      els.waStatusOk.classList.remove('hidden');
      els.waStatusWarn.classList.add('hidden');
      els.btnOpenWa.classList.add('hidden');
    } else {
      els.waStatusOk.classList.add('hidden');
      els.waStatusWarn.classList.remove('hidden');
      els.btnOpenWa.classList.remove('hidden');
    }
  }

  els.btnOpenWa.addEventListener('click', async () => {
    await sendMsg({ type: 'open-wa' });
  });

  els.btnLeave.addEventListener('click', async () => {
    els.btnLeave.disabled = true;
    await sendMsg({ type: 'leave' });
    els.btnLeave.disabled = false;
    await chrome.storage.local.remove(['roomId', 'roomName', 'connected']);
    selectedRoom = { id: '', name: '' };
    showStep('rooms');
    fetchRooms();
  });

  // --- Listen for background state updates ---

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg.type === 'state-update') {
      const data = msg.data || {};

      if (data.connected) {
        if (data.roomName) {
          selectedRoom.name = data.roomName;
          els.connectedRoomName.textContent = data.roomName;
        }
        updateWaStatus(data.waLoggedIn || false);
        if (data.lastAction) {
          els.lastAction.textContent = data.lastAction;
        }

        // If we're not already on connected step, switch to it
        if (!steps.connected.classList.contains('active')) {
          showConnectedView(data);
          showStep('connected');
        }
      } else {
        // Disconnected - go back to rooms
        if (steps.connected.classList.contains('active')) {
          showStep('rooms');
          fetchRooms();
        }
      }
    }

    if (msg.type === 'rooms-update') {
      const data = msg.data || {};
      els.roomsLoading.classList.add('hidden');
      if (data.error) {
        showError(els.roomsError, data.error);
      } else if (data.rooms) {
        renderRooms(data.rooms);
      }
    }
  });

  // --- Start ---
  init();
})();
