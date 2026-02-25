/* ==========================================================
   WhatsApp KeepAlive - Admin Panel JavaScript
   ========================================================== */

(function () {
  'use strict';

  // ===================== CONFIG =====================
  const API_BASE = '';  // Mismo origen
  const WS_RECONNECT_INTERVAL = 3000;  // ms

  // ===================== STATE =====================
  let token = localStorage.getItem('token');
  let ws = null;
  let wsReconnectTimer = null;
  let currentTab = 'rooms';
  let pendingDeleteCallback = null;
  let currentDetailRoomId = null;

  // Cache de datos
  let roomsData = [];
  let messagesData = [];
  let activityData = [];
  let lastStatusData = null; // Last WS status update

  // ===================== DOM REFS =====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Secciones
  const loginSection = $('#login-section');
  const dashboardSection = $('#dashboard-section');

  // Login
  const loginForm = $('#login-form');
  const loginUser = $('#login-user');
  const loginPass = $('#login-pass');
  const loginError = $('#login-error');
  const loginBtn = $('#login-btn');

  // Header
  const logoutBtn = $('#logout-btn');
  const connectionStatus = $('#connection-status');

  // Tabs
  const tabs = $$('.tab');
  const tabPanels = $$('.tab-panel');

  // Rooms
  const roomsList = $('#rooms-list');
  const roomsEmpty = $('#rooms-empty');
  const newRoomBtn = $('#new-room-btn');
  const roomModal = $('#room-modal');
  const roomModalTitle = $('#room-modal-title');
  const roomForm = $('#room-form');
  const roomEditId = $('#room-edit-id');
  const roomName = $('#room-name');
  const roomPassword = $('#room-password');
  const roomMinInterval = $('#room-min-interval');
  const roomMaxInterval = $('#room-max-interval');

  // Messages
  const messagesList = $('#messages-list');
  const messagesCount = $('#messages-count');
  const messageInput = $('#message-input');
  const addMessageBtn = $('#add-message-btn');

  // Activity
  const activityLog = $('#activity-log');
  const activityEmpty = $('#activity-empty');
  const clearActivityBtn = $('#clear-activity-btn');

  // Room detail modal
  const roomDetailModal = $('#room-detail-modal');
  const roomDetailTitle = $('#room-detail-title');
  const roomDetailMeta = $('#room-detail-meta');
  const roomDetailUsers = $('#room-detail-users');
  const roomDetailActivity = $('#room-detail-activity');

  // Confirm modal
  const confirmModal = $('#confirm-modal');
  const confirmMessage = $('#confirm-message');
  const confirmDeleteBtn = $('#confirm-delete-btn');

  // ===================== API HELPERS =====================

  /**
   * Realiza una petición autenticada al backend.
   * @param {string} path - Ruta relativa (ej: /api/rooms)
   * @param {object} options - Opciones adicionales de fetch
   * @returns {Promise<any>} Respuesta parseada como JSON
   */
  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    // Si no autenticado, volver al login
    if (res.status === 401 || res.status === 403) {
      handleLogout();
      throw new Error('Sesión expirada');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || `Error ${res.status}`);
    }

    // Manejar respuestas vacías (204 No Content, etc.)
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ===================== AUTH =====================

  /**
   * Intenta iniciar sesión con las credenciales dadas.
   */
  async function handleLogin(e) {
    e.preventDefault();
    loginError.hidden = true;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Ingresando...';

    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          user: loginUser.value.trim(),
          pass: loginPass.value,
        }),
      });

      token = data.token;
      localStorage.setItem('token', token);
      showDashboard();
    } catch (err) {
      loginError.textContent = err.message || 'Error al iniciar sesión';
      loginError.hidden = false;
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Iniciar sesión';
    }
  }

  /**
   * Cierra la sesión y vuelve al login.
   */
  function handleLogout() {
    token = null;
    localStorage.removeItem('token');
    disconnectWebSocket();
    showLogin();
  }

  /**
   * Verifica si el token actual es válido.
   * @returns {Promise<boolean>}
   */
  async function validateToken() {
    if (!token) return false;
    try {
      await api('/api/status');
      return true;
    } catch {
      return false;
    }
  }

  // ===================== NAVIGATION =====================

  /**
   * Muestra la sección de login.
   */
  function showLogin() {
    loginSection.hidden = false;
    dashboardSection.hidden = true;
    loginForm.reset();
    loginError.hidden = true;
    loginUser.focus();
  }

  /**
   * Muestra el dashboard y carga datos iniciales.
   */
  function showDashboard() {
    loginSection.hidden = true;
    dashboardSection.hidden = false;
    connectWebSocket();
    switchTab('rooms');
  }

  /**
   * Cambia a la pestaña indicada y carga sus datos.
   */
  function switchTab(tabName) {
    currentTab = tabName;

    // Actualizar clases de tabs
    tabs.forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // Mostrar/ocultar paneles
    tabPanels.forEach((p) => {
      p.classList.toggle('active', p.id === `${tabName}-tab`);
    });

    // Cargar datos frescos
    if (tabName === 'rooms') {
      loadRooms();
    } else if (tabName === 'messages') {
      loadMessages();
    } else if (tabName === 'activity') {
      loadActivity();
    }
  }

  // ===================== ROOMS =====================

  /**
   * Carga la lista de salas desde el backend.
   */
  async function loadRooms() {
    try {
      roomsData = await api('/api/rooms');
      applyStatusToRooms();
      renderRooms();
    } catch (err) {
      console.error('Error cargando salas:', err);
    }
  }

  /**
   * Renderiza las tarjetas de salas.
   */
  function renderRooms() {
    if (!roomsData || roomsData.length === 0) {
      roomsList.innerHTML = '';
      roomsEmpty.hidden = false;
      return;
    }

    roomsEmpty.hidden = true;
    roomsList.innerHTML = roomsData.map((room) => {
      const users = room.users || [];
      const userCount = users.length;
      const emptyClass = userCount === 0 ? 'empty' : '';

      const phoneItems = users.length > 0
        ? users.map((u) => {
            const statusClass = u.status || 'available';
            const phone = escapeHtml(u.phone || u.id || 'Desconocido');
            return `<li class="phone-item">
              <span class="phone-status ${statusClass}"></span>
              <span>${phone}</span>
            </li>`;
          }).join('')
        : '';

      const phonesSection = users.length > 0
        ? `<div class="room-phones">
             <div class="room-phones-title">Números conectados</div>
             <ul class="phone-list">${phoneItems}</ul>
           </div>`
        : `<div class="room-phones">
             <p class="room-no-phones">Sin números conectados</p>
           </div>`;


      return `<div class="room-card clickable" data-room-id="${room.id}" onclick="Admin.openRoomDetail('${room.id}')">
        <div class="room-card-header">
          <span class="room-card-name">${escapeHtml(room.name)}</span>
          <div class="room-card-actions">
            <button class="btn btn-outline btn-icon" onclick="event.stopPropagation(); Admin.editRoom('${room.id}')" title="Editar">&#9998;</button>
            <button class="btn btn-danger btn-icon" onclick="event.stopPropagation(); Admin.deleteRoom('${room.id}')" title="Eliminar">&#128465;</button>
          </div>
        </div>
        <div class="room-card-meta">
          <span class="room-interval">${room.minInterval || 20}-${room.maxInterval || 30} seg</span>
          <span class="room-user-count ${emptyClass}">
            <span class="dot"></span>
            ${userCount} ${userCount === 1 ? 'usuario' : 'usuarios'}
          </span>
        </div>
        ${phonesSection}
      </div>`;
    }).join('');
  }

  /**
   * Abre el modal para crear una nueva sala.
   */
  function openNewRoomModal() {
    roomModalTitle.textContent = 'Nueva Sala';
    roomForm.reset();
    roomEditId.value = '';
    roomMinInterval.value = 20;
    roomMaxInterval.value = 30;
    openModal(roomModal);
  }

  /**
   * Abre el modal para editar una sala existente.
   */
  function editRoom(roomId) {
    const room = roomsData.find((r) => r.id === roomId);
    if (!room) return;

    roomModalTitle.textContent = 'Editar Sala';
    roomEditId.value = room.id;
    roomName.value = room.name || '';
    roomPassword.value = room.password || '';
    roomMinInterval.value = room.minInterval || 20;
    roomMaxInterval.value = room.maxInterval || 30;
    openModal(roomModal);
  }

  /**
   * Guarda (crea o actualiza) una sala.
   */
  async function saveRoom(e) {
    e.preventDefault();

    const id = roomEditId.value;
    const body = {
      name: roomName.value.trim(),
      password: roomPassword.value.trim(),
      minInterval: parseInt(roomMinInterval.value, 10),
      maxInterval: parseInt(roomMaxInterval.value, 10),
    };

    // Validar que min <= max
    if (body.minInterval > body.maxInterval) {
      alert('El intervalo mínimo no puede ser mayor al máximo.');
      return;
    }

    try {
      if (id) {
        await api(`/api/rooms/${id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await api('/api/rooms', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }

      closeModal(roomModal);
      await loadRooms();
    } catch (err) {
      alert('Error al guardar la sala: ' + err.message);
    }
  }

  /**
   * Solicita confirmación y elimina una sala.
   */
  function deleteRoom(roomId) {
    const room = roomsData.find((r) => r.id === roomId);
    const name = room ? room.name : roomId;
    confirmMessage.textContent = `¿Estás seguro de que querés eliminar la sala "${name}"?`;
    pendingDeleteCallback = async () => {
      try {
        await api(`/api/rooms/${roomId}`, { method: 'DELETE' });
        await loadRooms();
      } catch (err) {
        alert('Error al eliminar la sala: ' + err.message);
      }
    };
    openModal(confirmModal);
  }

  // ===================== MESSAGES =====================

  async function loadMessages() {
    try {
      messagesData = await api('/api/messages');
      renderMessages();
    } catch (err) {
      console.error('Error cargando mensajes:', err);
    }
  }

  function renderMessages() {
    messagesCount.textContent = '(' + messagesData.length + ')';

    if (!messagesData || messagesData.length === 0) {
      messagesList.innerHTML = '<div class="detail-empty">Sin mensajes. Agregá uno abajo.</div>';
      return;
    }

    messagesList.innerHTML = messagesData.map((msg, idx) => {
      const text = escapeHtml(msg.message || '');
      return `<div class="msg-row">
        <span class="msg-num">${idx + 1}.</span>
        <span class="msg-text">${text}</span>
        <button class="msg-del" onclick="Admin.deleteMessage('${msg.id}')" title="Eliminar">&times;</button>
      </div>`;
    }).join('');
  }

  async function addMessage() {
    const text = messageInput.value.trim();
    if (!text) { messageInput.focus(); return; }

    try {
      await api('/api/messages', {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
      messageInput.value = '';
      await loadMessages();
    } catch (err) {
      alert('Error al agregar mensaje: ' + err.message);
    }
  }

  function deleteMessage(msgId) {
    const msg = messagesData.find((m) => m.id === msgId);
    const preview = msg ? msg.message.substring(0, 40) + (msg.message.length > 40 ? '...' : '') : msgId;
    confirmMessage.textContent = `Eliminar mensaje "${preview}"?`;
    pendingDeleteCallback = async () => {
      try {
        await api(`/api/messages/${msgId}`, { method: 'DELETE' });
        await loadMessages();
      } catch (err) {
        alert('Error al eliminar: ' + err.message);
      }
    };
    openModal(confirmModal);
  }

  // ===================== ACTIVITY =====================

  /**
   * Carga el historial de actividad desde el backend.
   */
  async function loadActivity() {
    try {
      const data = await api('/api/activity');
      activityData = Array.isArray(data) ? data : [];
      renderActivity();
    } catch (err) {
      console.error('Error cargando actividad:', err);
    }
  }

  /**
   * Renderiza la lista de actividad.
   */
  function renderActivity() {
    if (activityData.length === 0) {
      activityLog.innerHTML = '';
      activityEmpty.hidden = false;
      return;
    }

    activityEmpty.hidden = true;
    activityLog.innerHTML = activityData.map((entry) => {
      const ts = formatTimestamp(entry.timestamp);
      const room = escapeHtml(entry.roomName || entry.roomId || '-');
      const msg = escapeHtml(entry.message || entry.type || '');
      return `<div class="activity-entry">
        <span class="activity-timestamp">${ts}</span>
        <span class="activity-room">${room}</span>
        <span class="activity-message">${msg}</span>
      </div>`;
    }).join('');

    // Scroll al final (últimas entradas)
    activityLog.scrollTop = activityLog.scrollHeight;
  }

  /**
   * Agrega una entrada de actividad al principio de la lista (desde WebSocket).
   */
  function prependActivity(entry) {
    activityData.unshift(entry);

    // Limitar a 500 entradas en memoria
    if (activityData.length > 500) {
      activityData = activityData.slice(0, 500);
    }

    // Si el modal de detalle esta abierto y es la misma sala, actualizar
    if (currentDetailRoomId && !roomDetailModal.hidden && entry.roomId === currentDetailRoomId) {
      updateRoomDetail();
    }

    // Si estamos en la pestaña de actividad, actualizar el DOM directamente
    if (currentTab === 'activity') {
      activityEmpty.hidden = true;

      const ts = formatTimestamp(entry.timestamp);
      const room = escapeHtml(entry.roomName || entry.roomId || '-');
      const msg = escapeHtml(entry.message || entry.type || '');

      const div = document.createElement('div');
      div.className = 'activity-entry';
      div.innerHTML = `
        <span class="activity-timestamp">${ts}</span>
        <span class="activity-room">${room}</span>
        <span class="activity-message">${msg}</span>
      `;

      // Insertar al principio
      if (activityLog.firstChild) {
        activityLog.insertBefore(div, activityLog.firstChild);
      } else {
        activityLog.appendChild(div);
      }
    }
  }

  /**
   * Limpia la lista de actividad en la UI.
   */
  function clearActivity() {
    activityData = [];
    activityLog.innerHTML = '';
    activityEmpty.hidden = false;
  }

  // ===================== WEBSOCKET =====================

  /**
   * Establece la conexión WebSocket con el servidor.
   */
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/admin`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('Error creando WebSocket:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('WebSocket conectado');
      updateConnectionStatus(true);

      // Autenticar
      ws.send(JSON.stringify({
        type: 'auth',
        data: { token: token },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error('Error procesando mensaje WS:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket desconectado');
      updateConnectionStatus(false);
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('Error WebSocket:', err);
      // onclose se dispara después, no necesitamos reconectar aquí
    };
  }

  /**
   * Cierra la conexión WebSocket.
   */
  function disconnectWebSocket() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;  // Evitar reconexión automática
      ws.close();
      ws = null;
    }
    updateConnectionStatus(false);
  }

  /**
   * Programa un intento de reconexión.
   */
  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    if (!token) return;  // No reconectar si no hay token

    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWebSocket();
    }, WS_RECONNECT_INTERVAL);
  }

  /**
   * Actualiza el indicador visual de conexión.
   */
  function updateConnectionStatus(connected) {
    if (connected) {
      connectionStatus.classList.remove('disconnected');
      connectionStatus.classList.add('connected');
      connectionStatus.title = 'WebSocket conectado';
      connectionStatus.querySelector('.connection-text').textContent = 'Conectado';
    } else {
      connectionStatus.classList.remove('connected');
      connectionStatus.classList.add('disconnected');
      connectionStatus.title = 'WebSocket desconectado';
      connectionStatus.querySelector('.connection-text').textContent = 'Desconectado';
    }
  }

  /**
   * Procesa mensajes entrantes del WebSocket.
   */
  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'status':
        handleStatusUpdate(msg.data);
        break;

      case 'activity':
        prependActivity(msg.data);
        break;

      default:
        console.log('Mensaje WS desconocido:', msg.type, msg.data);
    }
  }

  /**
   * Procesa una actualización de estado de salas (usuarios conectados).
   */
  function handleStatusUpdate(data) {
    if (!data || !data.rooms) return;

    lastStatusData = data;
    applyStatusToRooms();

    // Si estamos en la pestaña de salas, re-renderizar
    if (currentTab === 'rooms') {
      renderRooms();
    }

    // Si el modal de detalle esta abierto, actualizar
    if (currentDetailRoomId && !roomDetailModal.hidden) {
      updateRoomDetail();
    }
  }

  function applyStatusToRooms() {
    if (!lastStatusData || !lastStatusData.rooms) return;

    const liveRooms = lastStatusData.rooms;

    roomsData.forEach((room) => {
      const live = liveRooms.find((lr) => lr.id === room.id);
      if (live) {
        room.users = (live.activeUsers || []).map((u) => ({
          phone: u.phone,
          status: u.available ? 'available' : 'busy',
        }));
        room.activePairs = live.activePairs || [];
      }
    });
  }

  // ===================== ROOM DETAIL =====================

  /**
   * Abre el modal de detalle de una sala.
   */
  function openRoomDetail(roomId) {
    currentDetailRoomId = roomId;
    updateRoomDetail();
    openModal(roomDetailModal);
  }

  /**
   * Actualiza el contenido del modal de detalle.
   */
  function updateRoomDetail() {
    if (!currentDetailRoomId) return;

    const room = roomsData.find((r) => r.id === currentDetailRoomId);
    if (!room) return;

    // Title
    roomDetailTitle.textContent = room.name || 'Sala';

    // Meta info
    const users = room.users || [];
    const userCount = users.length;
    const emptyClass = userCount === 0 ? 'empty' : '';
    roomDetailMeta.innerHTML = `
      <span class="room-interval">${room.minInterval || 20}-${room.maxInterval || 30} seg</span>
      <span class="room-user-count ${emptyClass}">
        <span class="dot"></span>
        ${userCount} ${userCount === 1 ? 'usuario' : 'usuarios'}
      </span>
    `;

    // Users
    if (users.length === 0) {
      roomDetailUsers.innerHTML = '<div class="detail-empty">Sin usuarios conectados</div>';
    } else {
      roomDetailUsers.innerHTML = users.map((u) => {
        const statusClass = u.status || 'available';
        const statusLabel = statusClass === 'busy' ? 'Ocupado' : 'Disponible';
        return `<div class="detail-user-item">
          <span class="phone-status ${statusClass}"></span>
          <span class="detail-user-phone">${escapeHtml(u.phone)}</span>
          <span class="detail-user-badge ${statusClass}">${statusLabel}</span>
        </div>`;
      }).join('');
    }

    // Activity (filtered by room)
    const roomActivity = activityData.filter((e) => e.roomId === currentDetailRoomId).slice(0, 50);
    if (roomActivity.length === 0) {
      roomDetailActivity.innerHTML = '<div class="detail-empty">Sin actividad</div>';
    } else {
      roomDetailActivity.innerHTML = roomActivity.map((entry) => {
        const ts = formatTimestamp(entry.timestamp);
        const msg = escapeHtml(entry.message || entry.type || '');
        return `<div class="activity-entry">
          <span class="activity-timestamp">${ts}</span>
          <span class="activity-message">${msg}</span>
        </div>`;
      }).join('');
    }
  }

  // ===================== MODAL HELPERS =====================

  /**
   * Abre un modal.
   */
  function openModal(modalEl) {
    modalEl.hidden = false;
    // Focus en el primer input del modal
    const firstInput = modalEl.querySelector('input:not([type="hidden"]), textarea, select');
    if (firstInput) {
      setTimeout(() => firstInput.focus(), 100);
    }
  }

  /**
   * Cierra un modal.
   */
  function closeModal(modalEl) {
    modalEl.hidden = true;
    if (modalEl === roomDetailModal) {
      currentDetailRoomId = null;
    }
  }

  // ===================== UTILITIES =====================

  /**
   * Escapa HTML para prevenir XSS.
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Formatea un timestamp ISO o epoch a formato legible.
   */
  function formatTimestamp(ts) {
    if (!ts) return '--:--:--';
    try {
      const date = new Date(ts);
      if (isNaN(date.getTime())) return String(ts);

      const pad = (n) => String(n).padStart(2, '0');
      const day = pad(date.getDate());
      const month = pad(date.getMonth() + 1);
      const hours = pad(date.getHours());
      const minutes = pad(date.getMinutes());
      const seconds = pad(date.getSeconds());

      return `${day}/${month} ${hours}:${minutes}:${seconds}`;
    } catch {
      return String(ts);
    }
  }

  // ===================== EVENT LISTENERS =====================

  // Login
  loginForm.addEventListener('submit', handleLogin);

  // Logout
  logoutBtn.addEventListener('click', handleLogout);

  // Tabs
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  // Room modal
  newRoomBtn.addEventListener('click', openNewRoomModal);
  roomForm.addEventListener('submit', saveRoom);

  // Messages
  addMessageBtn.addEventListener('click', addMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addMessage();
  });

  // Activity
  clearActivityBtn.addEventListener('click', clearActivity);

  // Confirm delete modal
  confirmDeleteBtn.addEventListener('click', async () => {
    if (pendingDeleteCallback) {
      await pendingDeleteCallback();
      pendingDeleteCallback = null;
    }
    closeModal(confirmModal);
  });

  // Close modal buttons (data-close="modal-id")
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      const modalId = closeBtn.dataset.close;
      const modal = document.getElementById(modalId);
      if (modal) closeModal(modal);
    }
  });

  // Cerrar modal al hacer click en el overlay (fuera del contenido)
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      closeModal(e.target);
    }
  });

  // Cerrar modales con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openModals = document.querySelectorAll('.modal-overlay:not([hidden])');
      openModals.forEach((m) => closeModal(m));
    }
  });

  // ===================== GLOBAL API (para onclick en HTML) =====================
  window.Admin = {
    editRoom,
    deleteRoom,
    deleteMessage,
    openRoomDetail,
  };

  // ===================== INIT =====================

  /**
   * Punto de entrada: verifica token y muestra la vista correcta.
   */
  async function init() {
    if (token) {
      const valid = await validateToken();
      if (valid) {
        showDashboard();
      } else {
        showLogin();
      }
    } else {
      showLogin();
    }
  }

  init();
})();
