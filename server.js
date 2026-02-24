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
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');

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

/** Array of { id, turns: [{ role: 'A'|'B', message: string }] } */
let conversations = [];

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

/** Active conversation pairs for live monitoring */
const activePairs = new Map();
let nextPairId = 0;

/** Cooldown set - phones that recently finished a conversation (5s cooldown) */
const cooldownPhones = new Set();
const COOLDOWN_MS = 5000;

/** Login rate limiting - Map<ip, { attempts, blockedUntil }> */
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// DEFAULT CONVERSATIONS (Argentine Spanish)
// =============================================================================

const DEFAULT_CONVERSATIONS = [
  {
    id: 'c1',
    turns: [
      { role: 'A', message: 'Hola, buen dia!' },
      { role: 'B', message: 'Hola! Que tal, como andas?' },
      { role: 'A', message: 'Todo bien por aca, laburando como siempre' },
      { role: 'B', message: 'Jaja igual que yo. Bueno, que tengas buen dia!' },
      { role: 'A', message: 'Igualmente! Nos hablamos' }
    ]
  },
  {
    id: 'c2',
    turns: [
      { role: 'A', message: 'Che, te prendes a hacer algo el finde?' },
      { role: 'B', message: 'Si! Que tenes pensado?' },
      { role: 'A', message: 'Estaba pensando en ir al cine o a comer algo' },
      { role: 'B', message: 'Uh re copado, yo prefiero ir a comer. Hay un lugar nuevo en Palermo' },
      { role: 'A', message: 'Dale, me re copa. A que hora nos vemos?' },
      { role: 'B', message: 'Tipo 9 de la noche te parece?' },
      { role: 'A', message: 'Joya, ahi queda entonces. Nos vemos el sabado!' },
      { role: 'B', message: 'Genial! Nos vemos, abrazo' }
    ]
  },
  {
    id: 'c3',
    turns: [
      { role: 'A', message: 'Feliz cumple!!! Que la pases re lindo hoy' },
      { role: 'B', message: 'Muchas gracias!! Que tierno/a' },
      { role: 'A', message: 'Vas a hacer algo para festejar?' },
      { role: 'B', message: 'Si, a la noche hacemos una juntada en casa con amigos' },
      { role: 'A', message: 'Que bueno! Necesitas que lleve algo?' },
      { role: 'B', message: 'Si podes traer algo para tomar estaria genial' },
      { role: 'A', message: 'Listo, llevo unas birras y un fernet' },
      { role: 'B', message: 'Gracias! Te espero a las 9 entonces' }
    ]
  },
  {
    id: 'c4',
    turns: [
      { role: 'A', message: 'Como te fue en la entrevista de laburo?' },
      { role: 'B', message: 'Bien! Creo que les gusto mi perfil' },
      { role: 'A', message: 'Que buena onda! De que es el puesto?' },
      { role: 'B', message: 'Es para desarrollo web en una startup. Pagan bastante bien' },
      { role: 'A', message: 'Re bien! Y cuando te dicen algo?' },
      { role: 'B', message: 'Me dijeron que en una semana me dan una respuesta' },
      { role: 'A', message: 'Bueno ojala que si! Te mereces algo bueno' },
      { role: 'B', message: 'Gracias! Yo tambien espero que salga. Te aviso cuando sepa algo' }
    ]
  },
  {
    id: 'c5',
    turns: [
      { role: 'A', message: 'Viste la serie nueva de Netflix? La de los zombies' },
      { role: 'B', message: 'No, cual? Estoy buscando algo para ver' },
      { role: 'A', message: 'Se llama "Ultimo refugio". Esta muy buena, la termine en dos dias' },
      { role: 'B', message: 'Ah la tengo en mi lista pero no la empece. Engancha mucho?' },
      { role: 'A', message: 'Si mal, los primeros dos capitulos son tranqui pero despues se pone re intensa' },
      { role: 'B', message: 'Dale, la arranco esta noche entonces' },
      { role: 'A', message: 'Despues contame que te parecio!' }
    ]
  },
  {
    id: 'c6',
    turns: [
      { role: 'A', message: 'Que calor hace hoy dios mio' },
      { role: 'B', message: 'Mal! Yo estoy derretido en la oficina, el aire no enfria nada' },
      { role: 'A', message: 'Aca en casa prendimos el ventilador pero tira aire caliente jaja' },
      { role: 'B', message: 'Dicen que manana baja un poco la temperatura por suerte' },
      { role: 'A', message: 'Ojala! Ya no se puede vivir asi' },
      { role: 'B', message: 'Tal cual. Bueno me voy a buscar un helado, nos hablamos!' },
      { role: 'A', message: 'Jaja buen plan. Suerte con el calor!' }
    ]
  },
  {
    id: 'c7',
    turns: [
      { role: 'A', message: 'Che sabes de algun lugar bueno para comer empanadas?' },
      { role: 'B', message: 'Si! Hay uno que se llama "El criollo" que son buenisimas' },
      { role: 'A', message: 'Donde queda?' },
      { role: 'B', message: 'En la calle Corrientes, a tres cuadras del obelisco mas o menos' },
      { role: 'A', message: 'Ah re bien. Y que te pediste vos?' },
      { role: 'B', message: 'Las de carne cortada a cuchillo son lo mejor. Y las de jamon y queso tambien van' },
      { role: 'A', message: 'Dale, voy a ir a probar. Gracias por la data!' },
      { role: 'B', message: 'De nada! Despues contame que tal' }
    ]
  },
  {
    id: 'c8',
    turns: [
      { role: 'A', message: 'Viste el partido de anoche? Que locura' },
      { role: 'B', message: 'Si lo vi! No lo podia creer, que golazo el del final' },
      { role: 'A', message: 'Mal, yo ya lo daba por perdido y de la nada pum' },
      { role: 'B', message: 'El pibe ese nuevo juega muy bien. Se merecia el gol' },
      { role: 'A', message: 'Si, tiene mucho futuro. Ojala no lo vendan rapido' },
      { role: 'B', message: 'Jaja olvidate, ya deben estar haciendo fila los europeos' }
    ]
  },
  {
    id: 'c9',
    turns: [
      { role: 'A', message: 'Te cambiaste el celular al final?' },
      { role: 'B', message: 'Si! Me compre el Samsung nuevo, esta muy bueno' },
      { role: 'A', message: 'Ah genial. Y la camara que tal? Vi que le meten mucha publicidad a eso' },
      { role: 'B', message: 'La verdad que si, las fotos salen increibles. De noche sobre todo' },
      { role: 'A', message: 'Yo estoy pensando en cambiar el mio pero estan carisimos' },
      { role: 'B', message: 'Si estan salados. Yo lo compre en 12 cuotas sin interes' },
      { role: 'A', message: 'Donde? Pasa el dato!' },
      { role: 'B', message: 'En Mercado Libre, con tarjeta del banco. Fijate que capaz todavia esta la promo' }
    ]
  },
  {
    id: 'c10',
    turns: [
      { role: 'A', message: 'Ey como estas? Hace rato no hablamos' },
      { role: 'B', message: 'Hola! Si posta, estuve re desaparecido. Todo bien?' },
      { role: 'A', message: 'Si todo tranqui, aca andamos. Vos que contas?' },
      { role: 'B', message: 'Nada, laburo y mas laburo. Pero bien dentro de todo' },
      { role: 'A', message: 'Me alegro. Tendriamos que juntarnos un dia de estos a tomar unas birras' },
      { role: 'B', message: 'Dale si! Hace mucho que no nos vemos. Coordino y te aviso' },
      { role: 'A', message: 'Joya, quedo atento. Un abrazo!' },
      { role: 'B', message: 'Abrazo grande! Hablamos pronto' }
    ]
  }
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

  // Load conversations
  if (fs.existsSync(CONVERSATIONS_FILE)) {
    try {
      conversations = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
      console.log(`[DATA] Loaded ${conversations.length} conversations`);
    } catch (err) {
      console.error('[DATA] Error loading conversations:', err.message);
      conversations = [...DEFAULT_CONVERSATIONS];
    }
  } else {
    conversations = [...DEFAULT_CONVERSATIONS];
    saveConversations();
    console.log('[DATA] Initialized with default conversations');
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

function saveConversations() {
  ensureDataDir();
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DATA] Error saving conversations:', err.message);
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
          totalTurns: pair.totalTurns,
          currentTurn: pair.currentTurn,
          currentSender: pair.currentSender,
          currentMessage: pair.currentMessage,
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

  shuffle(available);

  // Pair users while we have at least 2 available
  while (available.length >= 2) {
    const userA = available.pop();
    const userB = available.pop();

    // Mark as busy immediately
    userA.available = false;
    userB.available = false;

    // Pick a random conversation
    if (conversations.length === 0) {
      console.warn('[ENGINE] No conversations available, skipping pairing');
      userA.available = true;
      userB.available = true;
      return;
    }
    const conv = conversations[randomBetween(0, conversations.length - 1)];

    logActivity(roomId, 'pair', `Paired ${userA.phone} with ${userB.phone} (conv: ${conv.id})`);
    broadcastStatus();

    // Run the conversation asynchronously
    runConversation(roomId, userA, userB, conv);
  }
}

async function runConversation(roomId, userA, userB, conv) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Register active pair for live monitoring
  const pairId = 'p' + (++nextPairId);
  activePairs.set(pairId, {
    id: pairId,
    roomId,
    phoneA: userA.phone,
    phoneB: userB.phone,
    totalTurns: conv.turns.length,
    currentTurn: 0,
    currentSender: '',
    currentMessage: '',
    startedAt: new Date().toISOString(),
  });
  broadcastStatus();

  const minMs = (room.minInterval || 5) * 1000;
  const maxMs = (room.maxInterval || 15) * 1000;

  try {
    for (let i = 0; i < conv.turns.length; i++) {
      const turn = conv.turns[i];

      // Wait random delay between min and max interval
      const delay = randomBetween(minMs, maxMs);
      await sleep(delay);

      // Check both users still connected
      if (!extUsers.has(userA.phone) || !extUsers.has(userB.phone)) {
        logActivity(roomId, 'disconnect', `Conversacion interrumpida: usuario desconectado`);
        break;
      }

      // Determine sender and receiver based on role
      const sender = turn.role === 'A' ? userA : userB;
      const receiver = turn.role === 'A' ? userB : userA;

      // Update pair tracking
      const pair = activePairs.get(pairId);
      if (pair) {
        pair.currentTurn = i + 1;
        pair.currentSender = sender.phone;
        pair.currentMessage = turn.message;
      }
      broadcastStatus();

      // Send message with retry logic
      const success = await sendMessageWithRetry(sender, receiver.phone, turn.message);
      if (!success) {
        logActivity(roomId, 'error', `Fallo envio (${MAX_RETRIES + 1} intentos): ${sender.phone} -> ${receiver.phone}`);
        break;
      }

      // Log each successful message
      const preview = turn.message.length > 50 ? turn.message.substring(0, 50) + '...' : turn.message;
      logActivity(roomId, 'message', `${sender.phone} -> ${receiver.phone}: "${preview}"`);
    }
  } catch (err) {
    console.error('[ENGINE] Error in conversation:', err.message);
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

  logActivity(roomId, 'done', `Conversacion finalizada: ${userA.phone} <-> ${userB.phone}`);
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

// --- Conversations CRUD ---
app.get('/api/conversations', authMiddleware, (req, res) => {
  res.json(conversations);
});

app.post('/api/conversations', authMiddleware, (req, res) => {
  const { turns } = req.body || {};
  if (!turns || !Array.isArray(turns) || turns.length === 0) {
    return res.status(400).json({ error: 'turns array is required' });
  }
  // Validate message lengths (WhatsApp limit ~4096)
  for (const turn of turns) {
    if (!turn.message || !turn.role) {
      return res.status(400).json({ error: 'Each turn must have role and message' });
    }
    if (turn.message.length > 4096) {
      return res.status(400).json({ error: 'Message exceeds 4096 character limit' });
    }
  }
  const conv = { id: genId(), turns };
  conversations.push(conv);
  saveConversations();
  console.log(`[CONVERSATIONS] Created conversation ${conv.id} (${turns.length} turns)`);
  res.json(conv);
});

app.put('/api/conversations/:id', authMiddleware, (req, res) => {
  const idx = conversations.findIndex(c => c.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  const { turns } = req.body || {};
  if (turns !== undefined) {
    conversations[idx].turns = turns;
  }
  saveConversations();
  console.log(`[CONVERSATIONS] Updated conversation ${req.params.id}`);
  res.json(conversations[idx]);
});

app.delete('/api/conversations/:id', authMiddleware, (req, res) => {
  const idx = conversations.findIndex(c => c.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  conversations.splice(idx, 1);
  saveConversations();
  console.log(`[CONVERSATIONS] Deleted conversation ${req.params.id}`);
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

      // Mark available so conversation can abort cleanly
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
  console.log(`  Conversations: ${conversations.length}`);
  console.log(`  Admin panel: http://localhost:${PORT}`);
  console.log(`  WS Admin: ws://localhost:${PORT}/ws/admin`);
  console.log(`  WS Extension: ws://localhost:${PORT}/ws/ext`);
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
