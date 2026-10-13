// Whist room server. Run:  node server.js [port]      (default port 8080)
// No npm install needed — it only uses Node's built-in modules.
'use strict';
const { createServer } = require('./ws');
const { Game } = require('./game');
const os = require('os');
const dgram = require('dgram');
const DISCOVERY_PORT = 8089; // UDP port the app listens on to find servers automatically
const SERVER_NAME = os.hostname().slice(0, 30);

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
// Running on a hosting service (Render sets RENDER=true): no Wi-Fi announcements, simple log.
const CLOUD = !!(process.env.RENDER || process.env.WHIST_CLOUD);
const SPEED = parseFloat(process.env.WHIST_SPEED || '1'); // tests set this to 0 for instant pauses
const RECONNECT_GRACE_MS = 120000; // a dropped player keeps the seat this long
const QUIET = !!process.env.WHIST_QUIET;

const log = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); };

const rooms = new Map(); // key: lower-case room name
let nextId = 1;

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function send(c, msg) { if (c.ws.open) c.ws.send(JSON.stringify(msg)); }
function error(c, msg) { send(c, { t: 'error', msg }); }

// ---------------------------------------------------------------- rooms

function makeRoom(name, pin) {
  return {
    name, pin,
    clients: new Set(),
    seats: [null, null, null, null], // { name, conn|null, vacant, dropTimer }
    status: 'waiting',               // waiting | starting | playing
    game: null,
    rematch: new Set(),
    startTimer: null,
  };
}

function seatInfo(room) {
  return room.seats.map((s) => (s ? { name: s.name, connected: !!s.conn, vacant: !!s.vacant } : null));
}

function roomPayload(room, c) {
  return {
    t: 'room',
    room: room.name,
    pin: room.pin,
    status: room.status,
    seats: seatInfo(room),
    standing: [...room.clients].filter((x) => x.seat < 0 && !x.watching).map((x) => x.name),
    watchers: [...room.clients].filter((x) => x.watching).length,
    you: c.seat,
  };
}

function broadcastRoom(room) {
  for (const c of room.clients) send(c, roomPayload(room, c));
}

function viewFor(room, c) {
  const v = room.game.viewFor(c.seat);
  v.players = seatInfo(room);
  v.room = room.name;
  v.watching = c.seat < 0;
  v.rematch = [0, 1, 2, 3].map((i) => room.rematch.has(i));
  return v;
}

function broadcastEvent(room, ev) {
  if (!room.game) return;
  for (const c of room.clients) {
    if (c.seat < 0 && !c.watching) continue; // standing in the waiting room, not watching
    send(c, { t: 'ev', ev, view: viewFor(room, c) });
  }
}

function sync(room, c) { send(c, { t: 'sync', view: viewFor(room, c) }); }

function broadcastSync(room) {
  if (!room.game) return;
  for (const c of room.clients) if (c.seat >= 0 || c.watching) sync(room, c);
}

function maybeStart(room) {
  if (room.status !== 'waiting' || room.seats.some((s) => !s || !s.conn)) return;
  room.status = 'starting';
  broadcastRoom(room);
  room.startTimer = setTimeout(() => {
    room.startTimer = null;
    if (room.seats.some((s) => !s || !s.conn)) { room.status = 'waiting'; broadcastRoom(room); return; }
    startGame(room);
  }, 2200 * SPEED);
}

function startGame(room) {
  room.status = 'playing';
  room.rematch.clear();
  if (room.game) room.game.dispose();
  room.game = new Game({ emit: (ev) => onGameEvent(room, ev), speed: SPEED });
  log(`[${room.name}] game starts: ${room.seats.map((s) => s.name).join(', ')}`);
  for (const c of room.clients) {
    if (c.seat >= 0) send(c, { t: 'start' });
    else if (!c.watching) send(c, { t: 'full', room: room.name });
  }
  broadcastRoom(room);
  room.game.start();
}

function onGameEvent(room, ev) {
  if (ev.type === 'game_over') log(`[${room.name}] game over, team ${ev.team} wins ${ev.scores}`);
  broadcastEvent(room, ev);
}

function backToWaiting(room) {
  if (room.game) room.game.dispose();
  room.game = null;
  room.status = 'waiting';
  room.rematch.clear();
  for (let i = 0; i < 4; i++) {
    const s = room.seats[i];
    if (s && (!s.conn || s.vacant)) { if (s.dropTimer) clearTimeout(s.dropTimer); room.seats[i] = null; }
  }
  for (const c of room.clients) {
    c.watching = false;
    send(c, { t: 'to_waiting' });
  }
  broadcastRoom(room);
}

function deleteRoomIfEmpty(room) {
  const anyoneSeated = room.seats.some((s) => s && s.conn);
  const awaitingReconnect = room.seats.some((s) => s && s.dropTimer);
  if (room.clients.size === 0 && !anyoneSeated && !awaitingReconnect) {
    if (room.game) room.game.dispose();
    if (room.startTimer) clearTimeout(room.startTimer);
    for (const s of room.seats) if (s && s.dropTimer) clearTimeout(s.dropTimer);
    rooms.delete(room.name.toLowerCase());
    log(`[${room.name}] closed`);
  }
}

// Remove a connection from its room. dropped = connection lost (keep seat for a while).
function leaveRoom(c, dropped) {
  const room = c.room;
  if (!room) return;
  room.clients.delete(c);
  c.room = null;
  c.watching = false;
  const seat = c.seat;
  c.seat = -1;
  if (seat >= 0) {
    const s = room.seats[seat];
    if (room.status === 'playing') {
      s.conn = null;
      if (dropped) {
        s.dropTimer = setTimeout(() => {
          s.dropTimer = null;
          if (!s.conn) {
            s.vacant = true;
            if (room.game && room.game.phase === 'game_over') backToWaiting(room);
            else { broadcastSync(room); broadcastRoom(room); }
            deleteRoomIfEmpty(room);
          }
        }, RECONNECT_GRACE_MS);
      } else {
        s.vacant = true; // someone watching can take over
      }
      broadcastSync(room);
    } else {
      room.seats[seat] = null;
      if (room.status === 'starting') { clearTimeout(room.startTimer); room.startTimer = null; room.status = 'waiting'; }
    }
  }
  if (!dropped && room.status === 'playing' && room.game && room.game.phase === 'game_over' && seat >= 0) {
    backToWaiting(room); // someone left after the game: back to picking seats
  }
  broadcastRoom(room);
  deleteRoomIfEmpty(room);
}

// ---------------------------------------------------------------- messages

function enterRoom(c, room) {
  room.clients.add(c);
  c.room = room;
  c.seat = -1;
  c.watching = false;

  // Same name as a seat whose player dropped or left mid-game -> take the seat back.
  const idx = room.seats.findIndex((s) => s && !s.conn && same(s.name, c.name));
  if (idx >= 0 && room.status === 'playing') {
    const s = room.seats[idx];
    if (s.dropTimer) { clearTimeout(s.dropTimer); s.dropTimer = null; }
    s.conn = c; s.vacant = false; s.name = c.name;
    c.seat = idx;
    log(`[${room.name}] ${c.name} is back in seat ${idx}`);
    send(c, { t: 'joined', room: room.name, pin: room.pin, mode: 'game', you: c.name });
    broadcastRoom(room);
    broadcastSync(room);
    return;
  }
  const mode = room.status === 'playing' ? 'full' : 'waiting';
  send(c, { t: 'joined', room: room.name, pin: room.pin, mode, you: c.name });
  broadcastRoom(room);
}

function validName(c, name) {
  if (!name) { error(c, 'Please enter your name'); return false; }
  return true;
}

const handlers = {
  create(c, m) {
    const name = clean(m.name, 16), roomName = clean(m.room, 20), pin = clean(m.pin, 4);
    if (!validName(c, name)) return;
    if (!roomName) return error(c, 'Please name the room');
    if (!/^\d{4}$/.test(pin)) return error(c, 'The pass key must be 4 digits');
    if (rooms.has(roomName.toLowerCase())) return error(c, 'A room with that name already exists');
    if (c.room) leaveRoom(c, false);
    c.name = name;
    const room = makeRoom(roomName, pin);
    rooms.set(roomName.toLowerCase(), room);
    log(`[${roomName}] created by ${name}`);
    enterRoom(c, room);
  },

  join(c, m) {
    const name = clean(m.name, 16), roomName = clean(m.room, 20), pin = clean(m.pin, 4);
    if (!validName(c, name)) return;
    const room = rooms.get(roomName.toLowerCase());
    if (!room) return error(c, 'Room not found');
    if (room.pin !== pin) return error(c, 'Wrong pass key');
    const old = [...room.clients].find((x) => x !== c && same(x.name, name));
    if (old) {
      // A phone that lost its connection often rejoins before we notice the old socket died.
      // Same name + right key while seated in a game, or a silent old socket -> take it over.
      const stale = Date.now() - old.ws.lastSeen > 12000;
      if ((room.status === 'playing' && old.seat >= 0) || stale) {
        log(`[${room.name}] ${name} reconnected, replacing the old connection`);
        leaveRoom(old, true);
        old.ws.destroy();
      } else {
        return error(c, 'Someone in this room already uses that name');
      }
    }
    if (c.room) leaveRoom(c, false);
    c.name = name;
    enterRoom(c, room);
  },

  sit(c, m) {
    const room = c.room; if (!room) return;
    const i = m.seat | 0;
    if (i < 0 || i > 3) return;
    const s = room.seats[i];
    if (room.status === 'playing') {
      // Take over a seat someone left during the game.
      if (c.seat >= 0) return;
      if (!s || !s.vacant) return error(c, 'That seat is taken');
      if (s.dropTimer) { clearTimeout(s.dropTimer); s.dropTimer = null; }
      s.name = c.name; s.conn = c; s.vacant = false;
      c.seat = i; c.watching = false;
      log(`[${room.name}] ${c.name} took over seat ${i}`);
      send(c, { t: 'start' });
      broadcastRoom(room);
      broadcastSync(room);
      return;
    }
    if (room.status !== 'waiting') return;
    if (s) return error(c, 'That seat is taken');
    if (c.seat >= 0) room.seats[c.seat] = null;
    room.seats[i] = { name: c.name, conn: c, vacant: false, dropTimer: null };
    c.seat = i;
    broadcastRoom(room);
    maybeStart(room);
  },

  stand(c) {
    const room = c.room; if (!room || room.status !== 'waiting' || c.seat < 0) return;
    room.seats[c.seat] = null;
    c.seat = -1;
    broadcastRoom(room);
  },

  watch(c) {
    const room = c.room; if (!room || !room.game) return;
    c.watching = true;
    send(c, { t: 'watching' });
    sync(room, c);
    broadcastRoom(room);
  },

  leave(c) { leaveRoom(c, false); send(c, { t: 'left' }); },

  bid(c, m) { act(c, (g) => g.placeBid(c.seat, m.value | 0)); },
  trump(c, m) { act(c, (g) => g.chooseTrump(c.seat, String(m.suit))); },
  play(c, m) { act(c, (g) => g.play(c.seat, String(m.card))); },

  rematch(c) {
    const room = c.room; if (!room || !room.game || room.game.phase !== 'game_over' || c.seat < 0) return;
    room.rematch.add(c.seat);
    if (room.rematch.size === 4 && room.seats.every((s) => s && s.conn)) startGame(room);
    else broadcastSync(room);
  },

  resync(c) { if (c.room && c.room.game && (c.seat >= 0 || c.watching)) sync(c.room, c); },

  ping(c) { send(c, { t: 'pong' }); },
};

function act(c, fn) {
  const room = c.room;
  if (!room || !room.game || c.seat < 0) return;
  const err = fn(room.game);
  if (err) { error(c, err); sync(room, c); }
}

// ---------------------------------------------------------------- connections

const conns = new Set();

createServer(PORT, (ws, req) => {
  const c = { id: nextId++, ws, name: '', room: null, seat: -1, watching: false };
  conns.add(c);
  log(`#${c.id} connected from ${req.socket.remoteAddress}`);
  ws.on('message', (text) => {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    const h = handlers[m && m.t];
    if (h) {
      try { h(c, m); } catch (e) { console.error(e); error(c, 'Server error'); }
    }
  });
  ws.on('close', () => {
    conns.delete(c);
    log(`#${c.id} ${c.name || ''} disconnected`);
    leaveRoom(c, true);
  });
}, log, printAddresses);

const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Docker|vbox|virbr|^br-|docker|tailscale|ZeroTier|Hamachi|utun|awdl|llw/i;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address)) continue;
      out.push({ name, ip: a.address, netmask: a.netmask, virtual: VIRTUAL.test(name) });
    }
  }
  const score = (x) => (x.virtual ? 2 : 0) + (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(x.ip) ? 0 : 1);
  return out.sort((a, b) => score(a) - score(b));
}

function broadcastAddress(ip, mask) {
  const a = ip.split('.').map(Number), m = (mask || '255.255.255.0').split('.').map(Number);
  return a.map((v, i) => (v & m[i]) | (~m[i] & 255)).join('.');
}

// Tell phones on the same Wi-Fi where we are (they listen on UDP 8089).
function startBeacon() {
  if (CLOUD || process.env.WHIST_NO_BEACON) return;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => {});
  const msg = Buffer.from(JSON.stringify({ whist: 1, port: PORT, name: SERVER_NAME }));
  const send = () => {
    const targets = new Set(['255.255.255.255']);
    for (const x of lanAddresses()) if (!x.virtual) targets.add(broadcastAddress(x.ip, x.netmask));
    for (const t of targets) sock.send(msg, DISCOVERY_PORT, t, () => {});
  };
  sock.bind(0, () => {
    try { sock.setBroadcast(true); } catch (e) { return; }
    send();
    setInterval(send, 1500).unref();
  });
}

createServer.info = () => ({ whist: 1, name: SERVER_NAME, port: PORT, players: conns.size });

function printAddresses() {
  if (CLOUD) {
    console.log(`Whist online server running on port ${PORT} (${SERVER_NAME})`);
    return;
  }
  startBeacon();
  const ips = lanAddresses();
  const real = ips.filter((x) => !x.virtual);
  const best = real[0] || ips[0];
  const portSuffix = PORT === 8080 ? '' : ':' + PORT;
  const line = '='.repeat(62);
  console.log(`\n${line}\n  WHIST SERVER IS RUNNING   (computer name: ${SERVER_NAME})\n${line}`);
  if (!best) {
    console.log('  This computer is not on any network - connect it to Wi-Fi.');
  } else {
    console.log('  Phones on the same Wi-Fi find this server by themselves.');
    console.log('  If one does not, tap the gear in the app and type:\n');
    console.log(`      ${best.ip}${portSuffix}\n`);
    const others = ips.filter((x) => x !== best);
    if (others.length) {
      console.log('  Other addresses of this computer (only if the one above fails):');
      for (const x of others) console.log(`      ${x.ip}${portSuffix}    (${x.name}${x.virtual ? ', virtual - probably not this one' : ''})`);
      console.log('');
    }
    console.log(`  Test from the phone's browser:  http://${best.ip}:${PORT}`);
    console.log('  It must show "Whist server is running". If it does not load,');
    console.log('  run "FIX FIREWALL.bat" and make sure the phone uses the same Wi-Fi.');
  }
  console.log('  Keep this window open while you play.');
  console.log(`${line}\n`);
}
