// =============================================================================
// WhatsApp KeepAlive - Server
// Sistema para mantener activas lineas de WhatsApp con conversaciones simuladas
// =============================================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

// =============================================================================
// CONFIG
// =============================================================================

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const EXT_DIR = path.join(__dirname, 'extension');

// Compute hash of extension files at startup (changes on redeploy)
function computeExtVersion() {
  const files = ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'manifest.json'];
  let combined = '';
  for (const f of files) {
    try {
      combined += fs.readFileSync(path.join(EXT_DIR, f), 'utf-8');
    } catch (_) {}
  }
  return crypto.createHash('md5').update(combined).digest('hex').substring(0, 8);
}
const EXT_VERSION = computeExtVersion();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Fisher-Yates shuffle in place */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// =============================================================================
// IN-MEMORY DATA STORES
// =============================================================================

/** Map<roomId, { id, name, password, minInterval, maxInterval }> */
let rooms = new Map();

/** Array of { id, message: string } */
let messages = [];

/** Global message index - rotates through the list */
let messageIndex = 0;

/** Map<phone, phone> - last partner for each user (to avoid repeating) */
const lastPartner = new Map();

/** Map<phone, { phone, roomId, ws, available, pendingResolve }> */
const extUsers = new Map();

/** Set of valid admin bearer tokens */
const adminTokens = new Set();

/** Set of authenticated admin WebSocket clients */
const adminClients = new Set();

/** Activity log (max 200 entries) */
const activityLog = [];

/** Map<roomId, intervalId> - running pairing engines */
const roomEngines = new Map();

/** Active exchange pairs for live monitoring */
const activePairs = new Map();
let nextPairId = 0;

/** Cooldown set - phones that recently finished an exchange (5s cooldown) */
const cooldownPhones = new Set();
const COOLDOWN_MS = 5000;

/** Login rate limiting - Map<ip, { attempts, blockedUntil }> */
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// DEFAULT MESSAGES (Argentine Spanish - generic, one-liners)
// =============================================================================

const DEFAULT_MESSAGES = [
  { id: 'm1', message: 'Hola! Como andas?' },
  { id: 'm2', message: 'Todo bien por aca, vos?' },
  { id: 'm3', message: 'Buenas! Que tal todo?' },
  { id: 'm4', message: 'Ey que onda! Hace rato no hablamos' },
  { id: 'm5', message: 'Hola! Aca andamos, laburando como siempre' },
  { id: 'm6', message: 'Que tal? Todo tranqui?' },
  { id: 'm7', message: 'Buenas buenas! Como va eso?' },
  { id: 'm8', message: 'Hola! Que contas de nuevo?' },
  { id: 'm9', message: 'Ey! Como va todo por alla?' },
  { id: 'm10', message: 'Que onda! Tanto tiempo' },
  { id: 'm11', message: 'Hola! Paso a saludar, un abrazo!' },
  { id: 'm12', message: 'Como estas? Espero que todo bien!' },
  { id: 'm13', message: 'Buenas! Aca reportandome jaja' },
  { id: 'm14', message: 'Hola! Que tal el dia?' },
  { id: 'm15', message: 'Ey como va? Todo en orden?' },
  { id: 'm16', message: 'Que tal! Aca andamos bien, vos?' },
  { id: 'm17', message: 'Hola! Justo me acorde de vos, como estas?' },
  { id: 'm18', message: 'Buenas! Que se cuenta?' },
  { id: 'm19', message: 'Hola! Todo bien? Saludos!' },
  { id: 'm20', message: 'Que onda! Espero que andes bien!' },
];

// =============================================================================
// DATA PERSISTENCE
// =============================================================================

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadData() {
  ensureDataDir();

  // Load rooms
  if (fs.existsSync(ROOMS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf-8'));
      rooms = new Map(data.map(r => [r.id, r]));
      console.log(`[DATA] Loaded ${rooms.size} rooms`);
    } catch (err) {
      console.error('[DATA] Error loading rooms:', err.message);
      rooms = new Map();
    }
  } else {
    rooms = new Map();
    console.log('[DATA] No rooms file found, starting empty');
  }

  // Load messages
  if (fs.existsSync(MESSAGES_FILE)) {
    try {
      messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
      console.log(`[DATA] Loaded ${messages.length} messages`);
    } catch (err) {
      console.error('[DATA] Error loading messages:', err.message);
      messages = [...DEFAULT_MESSAGES];
    }
  } else {
    messages = [...DEFAULT_MESSAGES];
    saveMessages();
    console.log('[DATA] Initialized with default messages');
  }

  // Load activity log
  if (fs.existsSync(ACTIVITY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8'));
      activityLog.push(...data);
      console.log(`[DATA] Loaded ${activityLog.length} activity entries`);
    } catch (err) {
      console.error('[DATA] Error loading activity:', err.message);
    }
  }
}

function saveRooms() {
  ensureDataDir();
  try {
    const data = Array.from(rooms.values());
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DATA] Error saving rooms:', err.message);
  }
}

function saveMessages() {
  ensureDataDir();
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DATA] Error saving messages:', err.message);
  }
}

/** Debounced activity save - avoids writing too frequently */
let activitySaveTimer = null;
function saveActivityDebounced() {
  if (activitySaveTimer) return;
  activitySaveTimer = setTimeout(() => {
    activitySaveTimer = null;
    ensureDataDir();
    try {
      fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activityLog, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DATA] Error saving activity:', err.message);
    }
  }, 5000); // save at most every 5 seconds
}

// =============================================================================
// ACTIVITY LOG
// =============================================================================

function logActivity(roomId, type, message) {
  const room = rooms.get(roomId);
  const entry = {
    timestamp: new Date().toISOString(),
    roomId,
    roomName: room ? room.name : roomId,
    type,
    message
  };
  activityLog.unshift(entry);
  if (activityLog.length > 200) {
    activityLog.length = 200;
  }
  // Persist to disk (debounced)
  saveActivityDebounced();
  // Broadcast to admin clients
  broadcastToAdmins({ type: 'activity', data: entry });
  console.log(`[ACTIVITY] [${type}] Room ${roomId}: ${message}`);
}

// =============================================================================
// BROADCAST STATUS TO ADMIN CLIENTS
// =============================================================================

function getRoomStatuses() {
  const statuses = [];
  for (const [id, room] of rooms) {
    const activeUsers = [];
    for (const [phone, user] of extUsers) {
      if (user.roomId === id) {
        activeUsers.push({ phone, available: user.available });
      }
    }
    const pairs = [];
    for (const [, pair] of activePairs) {
      if (pair.roomId === id) {
        pairs.push({
          id: pair.id,
          phoneA: pair.phoneA,
          phoneB: pair.phoneB,
          messageA: pair.messageA,
          messageB: pair.messageB,
          startedAt: pair.startedAt,
        });
      }
    }
    statuses.push({
      id,
      name: room.name,
      activeCount: activeUsers.length,
      busyCount: activeUsers.filter(u => !u.available).length,
      activeUsers,
      activePairs: pairs,
    });
  }
  return statuses;
}

function broadcastStatus() {
  const data = { type: 'status', data: { rooms: getRoomStatuses() } };
  broadcastToAdmins(data);
}

function broadcastToAdmins(data) {
  const msg = JSON.stringify(data);
  for (const ws of adminClients) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(msg);
      }
    } catch (err) {
      console.error('[WS-ADMIN] Error sending to admin client:', err.message);
    }
  }
}

// =============================================================================
// PAIRING ENGINE
// =============================================================================

function startRoomEngine(roomId) {
  if (roomEngines.has(roomId)) return; // Already running

  const intervalId = setInterval(() => {
    checkAndPair(roomId);
  }, 5000);

  roomEngines.set(roomId, intervalId);
  console.log(`[ENGINE] Started pairing engine for room ${roomId}`);
}

function stopRoomEngine(roomId) {
  const intervalId = roomEngines.get(roomId);
  if (intervalId) {
    clearInterval(intervalId);
    roomEngines.delete(roomId);
    console.log(`[ENGINE] Stopped pairing engine for room ${roomId}`);
  }
}

function checkAndPair(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Get all available users in this room (exclude cooldown)
  const available = [];
  for (const [phone, user] of extUsers) {
    if (user.roomId === roomId && user.available === true && !cooldownPhones.has(phone)) {
      available.push(user);
    }
  }

  if (available.length < 2) return;

  if (messages.length === 0) {
    console.warn('[ENGINE] No messages available, skipping pairing');
    return;
  }

  shuffle(available);

  // Try to pair users avoiding recent partners
  while (available.length >= 2) {
    const userA = available.pop();

    // Find best partner: prefer someone who wasn't A's last partner
    let bestIdx = 0;
    for (let i = 0; i < available.length; i++) {
      if (lastPartner.get(userA.phone) !== available[i].phone) {
        bestIdx = i;
        break;
      }
    }
    const userB = available.splice(bestIdx, 1)[0];

    // Mark as busy immediately
    userA.available = false;
    userB.available = false;

    // Track partners for rotation
    lastPartner.set(userA.phone, userB.phone);
    lastPartner.set(userB.phone, userA.phone);

    // Get next 2 messages from rotating list
    const msgA = messages[messageIndex % messages.length].message;
    const msgB = messages[(messageIndex + 1) % messages.length].message;
    messageIndex += 2;

    logActivity(roomId, 'pair', `${userA.phone} <-> ${userB.phone}`);
    broadcastStatus();

    // Run exchange asynchronously (both send at the same time)
    runExchange(roomId, userA, userB, msgA, msgB);
  }
}

async function runExchange(roomId, userA, userB, msgA, msgB) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Register active pair for live monitoring
  const pairId = 'p' + (++nextPairId);
  activePairs.set(pairId, {
    id: pairId,
    roomId,
    phoneA: userA.phone,
    phoneB: userB.phone,
    messageA: msgA,
    messageB: msgB,
    startedAt: new Date().toISOString(),
  });
  broadcastStatus();

  const minMs = (room.minInterval || 5) * 1000;
  const maxMs = (room.maxInterval || 15) * 1000;

  try {
    // Wait random delay before sending
    const delay = randomBetween(minMs, maxMs);
    await sleep(delay);

    // Check both users still connected
    if (!extUsers.has(userA.phone) || !extUsers.has(userB.phone)) {
      logActivity(roomId, 'disconnect', `Intercambio interrumpido: usuario desconectado`);
    } else {
      // Send BOTH messages simultaneously (A→B and B→A)
      const [successA, successB] = await Promise.all([
        sendMessageWithRetry(userA, userB.phone, msgA),
        sendMessageWithRetry(userB, userA.phone, msgB),
      ]);

      if (successA) {
        const previewA = msgA.length > 50 ? msgA.substring(0, 50) + '...' : msgA;
        logActivity(roomId, 'message', `${userA.phone} -> ${userB.phone}: "${previewA}"`);
      } else {
        logActivity(roomId, 'error', `Fallo: ${userA.phone} -> ${userB.phone}`);
      }

      if (successB) {
        const previewB = msgB.length > 50 ? msgB.substring(0, 50) + '...' : msgB;
        logActivity(roomId, 'message', `${userB.phone} -> ${userA.phone}: "${previewB}"`);
      } else {
        logActivity(roomId, 'error', `Fallo: ${userB.phone} -> ${userA.phone}`);
      }
    }
  } catch (err) {
    console.error('[ENGINE] Error in exchange:', err.message);
    logActivity(roomId, 'error', `Error: ${err.message}`);
  }

  // Remove pair tracking
  activePairs.delete(pairId);

  // Add cooldown before making users available again
  cooldownPhones.add(userA.phone);
  cooldownPhones.add(userB.phone);
  setTimeout(() => cooldownPhones.delete(userA.phone), COOLDOWN_MS);
  setTimeout(() => cooldownPhones.delete(userB.phone), COOLDOWN_MS);

  // Mark both users as available again (if still connected)
  if (extUsers.has(userA.phone)) {
    userA.available = true;
  }
  if (extUsers.has(userB.phone)) {
    userB.available = true;
  }

  logActivity(roomId, 'done', `Intercambio finalizado: ${userA.phone} <-> ${userB.phone}`);
  broadcastStatus();
}

const MESSAGE_TIMEOUT_MS = 45000; // 45 seconds timeout (WA Web takes 10-30s to load)
const MAX_RETRIES = 1; // retry once (avoid duplicate sends in extension queue)

/**
 * Sends a message instruction to the extension and waits for confirmation.
 * Returns a Promise that resolves to true (success) or false (failure/timeout).
 */
function sendMessageAndWait(user, targetPhone, message) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      user.pendingResolve = null;
      console.warn(`[ENGINE] Message timeout for ${user.phone} -> ${targetPhone}`);
      resolve(false);
    }, MESSAGE_TIMEOUT_MS);

    // Store the resolve callback so message-sent handler can call it
    user.pendingResolve = (success) => {
      clearTimeout(timeout);
      user.pendingResolve = null;
      resolve(success);
    };

    // Send instruction to the extension
    try {
      if (user.ws.readyState === 1) {
        user.ws.send(JSON.stringify({
          type: 'send-message',
          data: { targetPhone, message }
        }));
      } else {
        clearTimeout(timeout);
        user.pendingResolve = null;
        resolve(false);
      }
    } catch (err) {
      clearTimeout(timeout);
      user.pendingResolve = null;
      console.error(`[ENGINE] Error sending to ${user.phone}:`, err.message);
      resolve(false);
    }
  });
}

/**
 * Sends a message with retry logic. Retries up to MAX_RETRIES times.
 */
async function sendMessageWithRetry(user, targetPhone, message) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (!extUsers.has(user.phone)) return false; // user disconnected
    if (attempt > 0) {
      console.log(`[ENGINE] Retry ${attempt}/${MAX_RETRIES} for ${user.phone} -> ${targetPhone}`);
      await sleep(2000); // wait 2s before retry
    }
    const success = await sendMessageAndWait(user, targetPhone, message);
    if (success) return true;
  }
  return false;
}

// =============================================================================
// ROOM ENGINE MANAGEMENT
// =============================================================================

function getUserCountInRoom(roomId) {
  let count = 0;
  for (const [, user] of extUsers) {
    if (user.roomId === roomId) count++;
  }
  return count;
}

function broadcastRoomUserCount(roomId) {
  const count = getUserCountInRoom(roomId);
  const msg = JSON.stringify({ type: 'room-user-count', data: { roomId, userCount: count } });
  for (const [, user] of extUsers) {
    if (user.roomId === roomId) {
      try {
        if (user.ws.readyState === 1) user.ws.send(msg);
      } catch (_) {}
    }
  }
}

function kickUsersFromRoom(roomId) {
  for (const [phone, user] of extUsers) {
    if (user.roomId === roomId) {
      try {
        user.ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Room has been deleted' }
        }));
        user.ws.close();
      } catch (err) {
        // Ignore close errors
      }
      extUsers.delete(phone);
    }
  }
}

// =============================================================================
// AUTH MIDDLEWARE
// =============================================================================

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  const token = authHeader.slice(7);
  if (!adminTokens.has(token)) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  next();
}

// =============================================================================
// EXPRESS APP
// =============================================================================

const app = express();

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Serve static files from ./public
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================================
// REST API
// =============================================================================

// --- Extension version (for auto-reload) ---
app.get('/api/ext-version', (req, res) => {
  res.json({ version: EXT_VERSION });
});

// --- Login (with rate limiting) ---
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const record = loginAttempts.get(ip) || { attempts: 0, blockedUntil: 0 };

  // Check if IP is blocked
  if (record.blockedUntil > Date.now()) {
    const remainSec = Math.ceil((record.blockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${remainSec}s` });
  }

  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    // Reset on successful login
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.add(token);
    console.log(`[AUTH] Admin logged in from ${ip}`);
    return res.json({ token });
  }

  // Failed attempt
  record.attempts++;
  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    record.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
    record.attempts = 0;
    console.warn(`[AUTH] IP ${ip} blocked for ${LOGIN_BLOCK_MS / 1000}s after ${MAX_LOGIN_ATTEMPTS} failed attempts`);
  }
  loginAttempts.set(ip, record);
  return res.status(401).json({ error: 'Invalid credentials' });
});

// --- Rooms CRUD ---
app.get('/api/rooms', authMiddleware, (req, res) => {
  res.json(Array.from(rooms.values()));
});

app.post('/api/rooms', authMiddleware, (req, res) => {
  const { name, password, minInterval, maxInterval } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const min = minInterval || 5;
  const max = maxInterval || 15;
  if (min > max) {
    return res.status(400).json({ error: 'minInterval cannot be greater than maxInterval' });
  }
  const room = {
    id: genId(),
    name,
    password: password || '',
    minInterval: min,
    maxInterval: max
  };
  rooms.set(room.id, room);
  saveRooms();
  logActivity(room.id, 'room-created', `Room "${name}" created`);
  broadcastStatus();
  console.log(`[ROOMS] Created room "${name}" (${room.id})`);
  res.json(room);
});

app.put('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const { name, password, minInterval, maxInterval } = req.body || {};
  if (name !== undefined) room.name = name;
  if (password !== undefined) room.password = password;
  if (minInterval !== undefined) room.minInterval = minInterval;
  if (maxInterval !== undefined) room.maxInterval = maxInterval;
  // Validate intervals
  if (room.minInterval > room.maxInterval) {
    return res.status(400).json({ error: 'minInterval cannot be greater than maxInterval' });
  }
  rooms.set(room.id, room);
  saveRooms();
  broadcastStatus();
  console.log(`[ROOMS] Updated room "${room.name}" (${room.id})`);
  res.json(room);
});

app.delete('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  // Stop engine and kick all users in this room
  stopRoomEngine(req.params.id);
  kickUsersFromRoom(req.params.id);
  rooms.delete(req.params.id);
  saveRooms();
  logActivity(req.params.id, 'room-deleted', `Room "${room.name}" deleted`);
  broadcastStatus();
  console.log(`[ROOMS] Deleted room "${room.name}" (${req.params.id})`);
  res.json({ ok: true });
});

// --- Messages CRUD ---
app.get('/api/messages', authMiddleware, (req, res) => {
  res.json(messages);
});

app.post('/api/messages', authMiddleware, (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message text is required' });
  }
  if (message.length > 4096) {
    return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
  }
  const msg = { id: genId(), message: message.trim() };
  messages.push(msg);
  saveMessages();
  console.log(`[MESSAGES] Created message ${msg.id}`);
  res.json(msg);
});

app.put('/api/messages/:id', authMiddleware, (req, res) => {
  const idx = messages.findIndex(m => m.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Message not found' });
  }
  const { message } = req.body || {};
  if (message !== undefined) {
    if (message.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }
    messages[idx].message = message.trim();
  }
  saveMessages();
  console.log(`[MESSAGES] Updated message ${req.params.id}`);
  res.json(messages[idx]);
});

app.delete('/api/messages/:id', authMiddleware, (req, res) => {
  const idx = messages.findIndex(m => m.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Message not found' });
  }
  messages.splice(idx, 1);
  saveMessages();
  console.log(`[MESSAGES] Deleted message ${req.params.id}`);
  res.json({ ok: true });
});

// --- Activity log ---
app.get('/api/activity', authMiddleware, (req, res) => {
  res.json(activityLog);
});

// --- Status ---
app.get('/api/status', authMiddleware, (req, res) => {
  res.json(getRoomStatuses());
});

// =============================================================================
// HTTP SERVER
// =============================================================================

const server = http.createServer(app);

// =============================================================================
// WEBSOCKET SERVERS (noServer mode)
// =============================================================================

const wssAdmin = new WebSocketServer({ noServer: true });
const wssExt = new WebSocketServer({ noServer: true });

// Route upgrade requests to the correct WebSocket server
server.on('upgrade', (request, socket, head) => {
  const { pathname } = url.parse(request.url);

  if (pathname === '/ws/admin') {
    wssAdmin.handleUpgrade(request, socket, head, (ws) => {
      wssAdmin.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/ext') {
    wssExt.handleUpgrade(request, socket, head, (ws) => {
      wssExt.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// =============================================================================
// ADMIN WEBSOCKET HANDLER
// =============================================================================

wssAdmin.on('connection', (ws) => {
  let authenticated = false;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'auth') {
        const token = msg.data && msg.data.token;
        if (token && adminTokens.has(token)) {
          authenticated = true;
          adminClients.add(ws);
          console.log('[WS-ADMIN] Admin client authenticated');
          // Send current status immediately
          ws.send(JSON.stringify({
            type: 'status',
            data: { rooms: getRoomStatuses() }
          }));
        } else {
          ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid token' } }));
          ws.close();
        }
      }
    } catch (err) {
      console.error('[WS-ADMIN] Error handling message:', err.message);
    }
  });

  ws.on('close', () => {
    adminClients.delete(ws);
    if (authenticated) {
      console.log('[WS-ADMIN] Admin client disconnected');
    }
  });

  ws.on('error', (err) => {
    console.error('[WS-ADMIN] WebSocket error:', err.message);
    adminClients.delete(ws);
  });
});

// =============================================================================
// EXTENSION WEBSOCKET HANDLER
// =============================================================================

wssExt.on('connection', (ws) => {
  /** Phone associated with this connection (set on join) */
  let userPhone = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {

        // ----- Get available rooms -----
        case 'get-rooms': {
          const roomList = Array.from(rooms.values()).map(r => ({
            id: r.id,
            name: r.name,
            hasPassword: !!r.password
          }));
          ws.send(JSON.stringify({ type: 'rooms', data: roomList }));
          break;
        }

        // ----- Join a room -----
        case 'join': {
          const { phone, roomId, password } = msg.data || {};

          if (!phone || !roomId) {
            ws.send(JSON.stringify({
              type: 'joined',
              data: { success: false, error: 'phone and roomId are required' }
            }));
            break;
          }

          // Validate phone format (digits only, 7-15 chars - E.164 without +)
          const cleanPhone = phone.replace(/[^0-9]/g, '');
          if (cleanPhone.length < 7 || cleanPhone.length > 15) {
            ws.send(JSON.stringify({
              type: 'joined',
              data: { success: false, error: 'Invalid phone number format (7-15 digits)' }
            }));
            break;
          }

          const room = rooms.get(roomId);
          if (!room) {
            ws.send(JSON.stringify({
              type: 'joined',
              data: { success: false, error: 'Room not found' }
            }));
            break;
          }

          if (room.password && room.password !== password) {
            ws.send(JSON.stringify({
              type: 'joined',
              data: { success: false, error: 'Invalid password' }
            }));
            break;
          }

          // If this phone is already connected, close the old connection
          if (extUsers.has(phone)) {
            const oldUser = extUsers.get(phone);
            try {
              oldUser.ws.close();
            } catch (e) {
              // Ignore
            }
            extUsers.delete(phone);
          }

          // Register this user
          userPhone = phone;
          const user = {
            phone,
            roomId,
            ws,
            available: true,
            pendingResolve: null
          };
          extUsers.set(phone, user);

          // Start room engine if not already running
          if (!roomEngines.has(roomId)) {
            startRoomEngine(roomId);
          }

          ws.send(JSON.stringify({
            type: 'joined',
            data: { success: true, roomName: room.name, userCount: getUserCountInRoom(roomId) }
          }));

          logActivity(roomId, 'join', `User ${phone} joined room "${room.name}"`);
          broadcastStatus();
          broadcastRoomUserCount(roomId);
          console.log(`[WS-EXT] ${phone} joined room "${room.name}" (${roomId})`);
          break;
        }

        // ----- Leave a room -----
        case 'leave': {
          if (userPhone && extUsers.has(userPhone)) {
            const user = extUsers.get(userPhone);
            const roomId = user.roomId;
            extUsers.delete(userPhone);

            logActivity(roomId, 'leave', `User ${userPhone} left`);

            // Stop engine if no more users in room
            if (getUserCountInRoom(roomId) === 0) {
              stopRoomEngine(roomId);
            }

            broadcastStatus();
            broadcastRoomUserCount(roomId);
            console.log(`[WS-EXT] ${userPhone} left room ${roomId}`);
          }
          userPhone = null;
          break;
        }

        // ----- Message sent confirmation from extension -----
        case 'message-sent': {
          if (userPhone && extUsers.has(userPhone)) {
            const user = extUsers.get(userPhone);
            if (user.pendingResolve) {
              const success = msg.data && msg.data.success === true;
              user.pendingResolve(success);
            }
          }
          break;
        }

        // ----- Ping/Pong -----
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default: {
          console.warn(`[WS-EXT] Unknown message type: ${msg.type}`);
          break;
        }
      }
    } catch (err) {
      console.error('[WS-EXT] Error handling message:', err.message);
      try {
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message format' } }));
      } catch (e) {
        // Ignore send errors
      }
    }
  });

  ws.on('close', () => {
    if (userPhone && extUsers.has(userPhone)) {
      const user = extUsers.get(userPhone);
      const roomId = user.roomId;

      // If user had a pending resolve, resolve it as failed
      if (user.pendingResolve) {
        user.pendingResolve(false);
      }

      // Mark available so exchange can abort cleanly
      user.available = true;

      extUsers.delete(userPhone);

      logActivity(roomId, 'disconnect', `User ${userPhone} disconnected`);

      // Stop engine if no more users in room
      if (getUserCountInRoom(roomId) === 0) {
        stopRoomEngine(roomId);
      }

      broadcastStatus();
      broadcastRoomUserCount(roomId);
      console.log(`[WS-EXT] ${userPhone} disconnected`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS-EXT] WebSocket error for ${userPhone || 'unknown'}:`, err.message);
  });
});

// =============================================================================
// START SERVER
// =============================================================================

loadData();

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`  WhatsApp KeepAlive Server`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Admin: ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log(`  Rooms: ${rooms.size}`);
  console.log(`  Messages: ${messages.length}`);
  console.log(`  Admin panel: http://localhost:${PORT}`);
  console.log(`  WS Admin: ws://localhost:${PORT}/ws/admin`);
  console.log(`  WS Extension: ws://localhost:${PORT}/ws/ext`);
  console.log(`  Extension version: ${EXT_VERSION}`);
  console.log('='.repeat(60));
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}, shutting down gracefully...`);

  // Save activity log immediately
  try {
    ensureDataDir();
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activityLog, null, 2), 'utf-8');
    console.log('[SHUTDOWN] Activity log saved');
  } catch (err) {
    console.error('[SHUTDOWN] Error saving activity:', err.message);
  }

  // Stop all room engines
  for (const [roomId] of roomEngines) {
    stopRoomEngine(roomId);
  }

  // Close all extension WS connections
  for (const [, user] of extUsers) {
    try {
      user.ws.close(1001, 'Server shutting down');
    } catch (_) {}
  }

  // Close all admin WS connections
  for (const ws of adminClients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch (_) {}
  }

  // Close HTTP server
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('[SHUTDOWN] Forced exit after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
