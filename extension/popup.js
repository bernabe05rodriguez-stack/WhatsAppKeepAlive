// popup.js - WhatsApp KeepAlive Extension Popup

(function () {
  'use strict';

  // URL del servidor por defecto (hardcodeada)
  const DEFAULT_SERVER = 'https://redhawk-whatsapp-keepalive.bm6z1s.easypanel.host';

  // --- DOM ---
  const steps = {
    phone:     document.getElementById('step-phone'),
    rooms:     document.getElementById('step-rooms'),
    password:  document.getElementById('step-password'),
    connected: document.getElementById('step-connected'),
  };

  const els = {
    inputPhone:    document.getElementById('input-phone'),
    inputServer:   document.getElementById('input-server'),
    btnSettings:   document.getElementById('btn-settings'),
    settingsArea:  document.getElementById('settings-area'),
    btnContinue:   document.getElementById('btn-continue'),
    btnBackRooms:  document.getElementById('btn-back-rooms'),
    roomsLoading:  document.getElementById('rooms-loading'),
    roomsList:     document.getElementById('rooms-list'),
    roomsError:    document.getElementById('rooms-error'),
    btnBackPassword: document.getElementById('btn-back-password'),
    passwordTitle:   document.getElementById('password-title'),
    inputPassword:   document.getElementById('input-password'),
    btnJoin:         document.getElementById('btn-join'),
    passwordError:   document.getElementById('password-error'),
    connectedRoomName: document.getElementById('connected-room-name'),
    connectedPhone: document.getElementById('connected-phone'),
    userCount:    document.getElementById('user-count'),
    lastAction:   document.getElementById('last-action'),
    btnLeave:     document.getElementById('btn-leave'),
  };

  let selectedRoom = { id: '', name: '', hasPassword: true };

  // --- Helpers ---

  function showStep(name) {
    Object.values(steps).forEach(s => s.classList.remove('active'));
    if (steps[name]) steps[name].classList.add('active');
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
      chrome.runtime.sendMessage(msg, (response) => resolve(response));
    });
  }

  // --- Toggle settings ---

  els.btnSettings.addEventListener('click', () => {
    els.settingsArea.classList.toggle('hidden');
  });

  // --- Init ---

  async function init() {
    const stored = await chrome.storage.local.get(['serverUrl', 'phone']);

    // Precargar servidor (default si no hay guardado)
    els.inputServer.value = stored.serverUrl || DEFAULT_SERVER;
    if (stored.phone) els.inputPhone.value = stored.phone;

    // Ver estado actual
    const state = await sendMsg({ type: 'get-state' });

    if (state && state.connected) {
      selectedRoom.id = state.roomId || '';
      selectedRoom.name = state.roomName || '';
      showConnectedView(state);
      showStep('connected');
    } else if (stored.phone) {
      const serverUrl = stored.serverUrl || DEFAULT_SERVER;
      await chrome.storage.local.set({ serverUrl });
      await sendMsg({ type: 'set-config', data: { serverUrl, phone: stored.phone } });
      showStep('rooms');
      fetchRooms();
    } else {
      showStep('phone');
    }
  }

  // --- Step 1: Telefono ---

  els.btnContinue.addEventListener('click', async () => {
    const phone = els.inputPhone.value.trim();
    const serverUrl = (els.inputServer.value.trim().replace(/\/+$/, '')) || DEFAULT_SERVER;

    if (!phone) { els.inputPhone.focus(); return; }

    els.btnContinue.disabled = true;
    await chrome.storage.local.set({ serverUrl, phone });
    await sendMsg({ type: 'set-config', data: { serverUrl, phone } });
    els.btnContinue.disabled = false;

    showStep('rooms');
    fetchRooms();
  });

  // --- Step 2: Salas ---

  els.btnBackRooms.addEventListener('click', () => showStep('phone'));

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
      showError(els.roomsError, 'No hay salas disponibles. El admin debe crear una.');
    }
  }

  function renderRooms(rooms) {
    els.roomsList.innerHTML = '';
    rooms.forEach((room) => {
      const card = document.createElement('div');
      card.className = 'room-card';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'room-card-name';
      nameSpan.textContent = room.name || room.id;
      card.appendChild(nameSpan);

      if (room.userCount !== undefined) {
        const countSpan = document.createElement('span');
        countSpan.className = 'room-card-count';
        countSpan.textContent = room.userCount + (room.userCount === 1 ? ' usuario' : ' usuarios');
        card.appendChild(countSpan);
      }

      card.addEventListener('click', () => {
        selectedRoom.id = room.id;
        selectedRoom.name = room.name || room.id;
        selectedRoom.hasPassword = room.hasPassword !== false;

        if (selectedRoom.hasPassword) {
          els.passwordTitle.textContent = selectedRoom.name;
          els.inputPassword.value = '';
          hideError(els.passwordError);
          showStep('password');
        } else {
          joinRoom('');
        }
      });
      els.roomsList.appendChild(card);
    });
  }

  // --- Step 3: Contrasena ---

  els.btnBackPassword.addEventListener('click', () => showStep('rooms'));

  async function joinRoom(password) {
    els.btnJoin.disabled = true;
    hideError(els.passwordError);

    const response = await sendMsg({
      type: 'join',
      data: { roomId: selectedRoom.id, password },
    });

    els.btnJoin.disabled = false;

    if (response && response.success) {
      await chrome.storage.local.set({ roomId: selectedRoom.id, roomName: selectedRoom.name });
      showConnectedView(response);
      showStep('connected');
    } else {
      if (!selectedRoom.hasPassword) {
        els.passwordTitle.textContent = selectedRoom.name;
        els.inputPassword.value = '';
        showStep('password');
      }
      showError(els.passwordError, response?.error || 'Contrasena incorrecta');
    }
  }

  els.btnJoin.addEventListener('click', async () => {
    const password = els.inputPassword.value;
    if (!password) { els.inputPassword.focus(); return; }
    await joinRoom(password);
  });

  // --- Step 4: Conectado ---

  function showConnectedView(state) {
    els.connectedRoomName.textContent = selectedRoom.name || state?.roomName || 'Sala';
    els.lastAction.textContent = state?.lastAction || '';
    updateUserCount(state?.userCount);
    if (state?.phone) {
      els.connectedPhone.textContent = '+' + state.phone;
    }
  }

  function updateUserCount(count) {
    if (count !== undefined && count !== null) {
      els.userCount.textContent = count + (count === 1 ? ' usuario' : ' usuarios');
    }
  }

  els.btnLeave.addEventListener('click', async () => {
    els.btnLeave.disabled = true;
    await sendMsg({ type: 'leave' });
    els.btnLeave.disabled = false;
    await chrome.storage.local.remove(['roomId', 'roomName', 'connected']);
    selectedRoom = { id: '', name: '', hasPassword: true };
    showStep('rooms');
    fetchRooms();
  });

  // --- Escuchar updates del background ---

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'state-update') {
      const data = msg.data || {};
      if (data.connected) {
        if (data.roomName) {
          selectedRoom.name = data.roomName;
          els.connectedRoomName.textContent = data.roomName;
        }
        if (data.lastAction) els.lastAction.textContent = data.lastAction;
        if (data.userCount !== undefined) updateUserCount(data.userCount);
        if (!steps.connected.classList.contains('active')) {
          showConnectedView(data);
          showStep('connected');
        }
      } else {
        if (steps.connected.classList.contains('active')) {
          showStep('rooms');
          fetchRooms();
        }
      }
    }
    if (msg.type === 'rooms-update') {
      const data = msg.data || {};
      els.roomsLoading.classList.add('hidden');
      if (data.error) { showError(els.roomsError, data.error); }
      else if (data.rooms) { renderRooms(data.rooms); }
    }
  });

  init();
})();
