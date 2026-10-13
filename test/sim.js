// End-to-end simulation: starts the server, 4 bots play full games, 1 spectator watches.
// node test/sim.js [games]
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const GAMES = parseInt(process.argv[2] || '3', 10);
const URL = `ws://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(PORT)], {
  env: { ...process.env, WHIST_SPEED: '0', WHIST_QUIET: '1' }, stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { name, ws, msgs: [], handlers: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); c.msgs.push(m); for (const h of c.handlers) h(m); };
    ws.onopen = () => resolve(c);
    ws.onerror = reject;
  });
}
const waitFor = (c, pred, ms = 5000) => new Promise((resolve, reject) => {
  const hit = c.msgs.find(pred); if (hit) return resolve(hit);
  const to = setTimeout(() => reject(new Error(`${c.name}: timeout`)), ms);
  c.handlers.push((m) => { if (pred(m)) { clearTimeout(to); resolve(m); } });
});

function bot(c, stats) {
  c.handlers.push((m) => {
    if (m.t === 'error') stats.errors.push(`${c.name}: ${m.msg}`);
    if (m.t !== 'ev' && m.t !== 'sync') return;
    const v = m.view;
    if (m.t === 'ev') {
      stats.events[m.ev.type] = (stats.events[m.ev.type] || 0) + 1;
      if (m.ev.type === 'round_end' && c.name === 'A') stats.rounds.push(m.ev.result);
      if (m.ev.type === 'game_over' && c.name === 'A') stats.over.push(m.ev);
    }
    if (v.turn !== v.seat) {
      if (v.phase === 'game_over' && !v.rematch[v.seat] && stats.over.length < GAMES) c.send({ t: 'rematch' });
      return;
    }
    const act = m.t === 'sync' || ['deal', 'turn', 'bid_won', 'trump'].includes(m.ev.type);
    if (!act) return;
    const key = [v.phase, v.round, v.counts.join(), v.bidding.last.join(), v.bidding.round, v.trick.length].join('|');
    if (c.lastKey === key) return; // already acted on this exact state
    c.lastKey = key;
    if (v.phase === 'bidding') {
      // sensible bots: open at 7, sometimes raise to 8, rarely shoot the moon
      const r = Math.random();
      let val = 0;
      if (v.bidding.highest === 0 && r < 0.5) val = 7;
      else if (v.bidding.highest === 7 && r < 0.25) val = 8;
      else if (r < 0.003) val = 13;
      c.send({ t: 'bid', value: val });
    } else if (v.phase === 'trump') {
      c.send({ t: 'trump', suit: 'CDHS'[Math.floor(Math.random() * 4)] });
    } else if (v.phase === 'playing') {
      assert.ok(v.legal.length > 0, 'legal cards when it is my turn');
      c.send({ t: 'play', card: v.legal[Math.floor(Math.random() * v.legal.length)] });
    }
  });
}

(async () => {
  await sleep(400);
  const stats = { errors: [], events: {}, rounds: [], over: [] };
  const [a, b, cc, d, e, f] = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F'].map(client));

  // Lobby errors
  a.send({ t: 'join', name: 'A', room: 'Nope', pin: '1234' });
  assert.strictEqual((await waitFor(a, (m) => m.t === 'error')).msg, 'Room not found');
  a.msgs.length = 0;
  a.send({ t: 'create', name: 'A', room: 'Table1', pin: '12a4' });
  assert.match((await waitFor(a, (m) => m.t === 'error')).msg, /4 digits/);
  a.send({ t: 'create', name: 'A', room: 'Table1', pin: '1234' });
  assert.strictEqual((await waitFor(a, (m) => m.t === 'joined')).mode, 'waiting');
  b.send({ t: 'join', name: 'B', room: 'table1', pin: '9999' });
  assert.strictEqual((await waitFor(b, (m) => m.t === 'error')).msg, 'Wrong pass key');
  b.msgs.length = 0;
  b.send({ t: 'join', name: 'a', room: 'table1', pin: '1234' });
  assert.match((await waitFor(b, (m) => m.t === 'error')).msg, /already uses/);
  for (const [c, n] of [[b, 'B'], [cc, 'C'], [d, 'D'], [e, 'E']]) c.send({ t: 'join', name: n, room: 'Table1', pin: '1234' });
  await waitFor(e, (m) => m.t === 'joined');

  for (const c of [a, b, cc, d]) bot(c, stats);
  // Seats: A=0, B=1, C=2, D=3; seat collision check
  a.send({ t: 'sit', seat: 0 });
  await waitFor(a, (m) => m.t === 'room' && m.you === 0);
  e.send({ t: 'sit', seat: 0 });
  assert.strictEqual((await waitFor(e, (m) => m.t === 'error')).msg, 'That seat is taken');
  b.send({ t: 'sit', seat: 1 }); cc.send({ t: 'sit', seat: 2 }); d.send({ t: 'sit', seat: 3 });

  await waitFor(e, (m) => m.t === 'full');
  e.send({ t: 'watch' });
  const ws = await waitFor(e, (m) => m.t === 'sync');
  assert.strictEqual(ws.view.seat, -1);
  assert.strictEqual(ws.view.hand.length, 0);

  // Late joiner while playing gets "full"
  f.send({ t: 'join', name: 'F', room: 'Table1', pin: '1234' });
  assert.strictEqual((await waitFor(f, (m) => m.t === 'joined')).mode, 'full');

  // Reconnect: D drops mid-game and comes back with the same name
  await waitFor(d, (m) => m.t === 'ev' && m.ev.type === 'play');
  d.ws.close();
  await sleep(150);
  const d2 = await client('D');
  bot(d2, stats);
  d2.send({ t: 'join', name: 'D', room: 'Table1', pin: '1234' });
  assert.strictEqual((await waitFor(d2, (m) => m.t === 'joined')).mode, 'game');
  const rs = await waitFor(d2, (m) => m.t === 'sync');
  assert.strictEqual(rs.view.seat, 3);

  const t0 = Date.now();
  while (stats.over.length < GAMES && Date.now() - t0 < 60000) await sleep(50);
  if (stats.over.length < GAMES) console.log('DEBUG', JSON.stringify(stats.events), stats.errors.slice(0,5), JSON.stringify(a.msgs[a.msgs.length-1]).slice(0,600));
  assert.strictEqual(stats.over.length, GAMES, `finished ${stats.over.length}/${GAMES} games`);

  // Check scoring consistency across rounds
  for (const r of stats.rounds) {
    assert.strictEqual(r.tricks[0] + r.tricks[1], 13);
    const bt = r.bidder % 2;
    if (r.made) assert.strictEqual(r.delta[bt], r.bid === 13 && r.tricks[bt] === 13 ? 26 : r.tricks[bt]);
    else {
      assert.strictEqual(r.delta[bt], -r.bid);
      assert.strictEqual(r.delta[1 - bt], r.tricks[1 - bt] >= 7 ? r.tricks[1 - bt] : 0);
    }
  }
  for (const g of stats.over) assert.ok(g.scores[g.team] >= 51);
  const specEvents = e.msgs.filter((m) => m.t === 'ev').length;
  assert.ok(specEvents > 100, 'spectator receives events');
  assert.ok(e.msgs.filter((m) => m.t === 'ev').every((m) => m.view.hand.length === 0), 'spectator never sees hands');

  // Takeover: "A" rejoins from a new connection while the old one still looks alive.
  const a2 = await client('A');
  a2.send({ t: 'join', name: 'A', room: 'Table1', pin: '1234' });
  assert.strictEqual((await waitFor(a2, (m) => m.t === 'joined')).mode, 'game');
  assert.strictEqual((await waitFor(a2, (m) => m.t === 'sync')).view.seat, 0);
  // ...but a different person can't steal a name in the waiting room
  const g1 = await client('G1'), g2 = await client('G2');
  g1.send({ t: 'create', name: 'Gil', room: 'Other', pin: '0000' });
  await waitFor(g1, (m) => m.t === 'joined');
  g2.send({ t: 'join', name: 'gil', room: 'Other', pin: '0000' });
  assert.match((await waitFor(g2, (m) => m.t === 'error')).msg, /already uses/);

  console.log(`games: ${stats.over.length}, rounds: ${stats.rounds.length}, spectator events: ${specEvents}`);
  console.log('events:', JSON.stringify(stats.events));
  console.log('final scores:', stats.over.map((g) => g.scores.join('-')).join(', '));
  const unexpected = stats.errors;
  console.log('bot errors:', unexpected.length ? unexpected : 'none');
  assert.strictEqual(unexpected.length, 0);
  console.log('SIMULATION OK');
  server.kill();
  process.exit(0);
})().catch((err) => { console.error('FAILED:', err); server.kill(); process.exit(1); });
