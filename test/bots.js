// Helper bots that join a room and play (used to test the Godot client).
// node test/bots.js ws://127.0.0.1:8080 RoomName 1234 "Maya:1,Omar:2,Lior:3" [delayMs] [watcherName]
'use strict';
const [url, room, pin, list, delayArg, watcher] = process.argv.slice(2);
const delay = parseInt(delayArg || '500', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bot(name, seat) {
  const ws = new WebSocket(url);
  let lastKey = '';
  const send = (m) => ws.send(JSON.stringify(m));
  ws.onopen = () => send({ t: 'join', name, room, pin });
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'error') console.log(`[${name}] error: ${m.msg}`);
    if (m.t === 'error' && m.msg === 'Room not found') { await sleep(1500); send({ t: 'join', name, room, pin }); return; }
    if (m.t === 'room' && m.you < 0 && m.status === 'waiting' && seat >= 0 && !m.seats[seat]) {
      await sleep(delay * 2); send({ t: 'sit', seat });
    }
    if (m.t === 'full' && seat < 0) send({ t: 'watch' });
    if (m.t === 'joined' && m.mode === 'full' && seat < 0) send({ t: 'watch' });
    if (m.t !== 'ev' && m.t !== 'sync') return;
    const v = m.view;
    if (v.phase === 'game_over' && v.seat >= 0 && !v.rematch[v.seat]) { await sleep(delay * 4); send({ t: 'rematch' }); return; }
    if (v.seat < 0 || v.turn !== v.seat) return;
    const key = [v.phase, v.round, v.counts.join(), v.bidding.last.join(), v.bidding.round, v.trick.length].join('|');
    if (key === lastKey) return;
    lastKey = key;
    await sleep(delay + Math.random() * delay);
    if (v.phase === 'bidding') {
      let val = 0;
      if (v.bidding.highest === 0 && Math.random() < 0.5) val = 7;
      else if (v.bidding.highest > 0 && v.bidding.highest < 9 && Math.random() < 0.3) val = v.bidding.minBid;
      send({ t: 'bid', value: val });
    } else if (v.phase === 'trump') {
      send({ t: 'trump', suit: 'CDHS'[Math.floor(Math.random() * 4)] });
    } else if (v.phase === 'playing') {
      send({ t: 'play', card: v.legal[Math.floor(Math.random() * v.legal.length)] });
    }
  };
  ws.onclose = () => console.log(`[${name}] closed`);
}

(async () => {
  for (const item of list.split(',')) {
    const [name, seat] = item.split(':');
    bot(name, parseInt(seat, 10));
    await sleep(300);
  }
  if (watcher) { await sleep(500); bot(watcher, -1); }
})();
