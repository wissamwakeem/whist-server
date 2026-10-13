// Minimal, dependency-free WebSocket server (RFC 6455, text frames only).
// Enough for a private game server: handshake, masking, fragmentation, ping/pong, close.
'use strict';
const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.open = true;
    this.lastSeen = Date.now();
    sock.setNoDelay(true);
    sock.on('data', (d) => this._onData(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > 1 << 20) { this.close(); return; } // 1 MB cap, nobody needs more here
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      this._onFrame(fin, op, payload);
      if (!this.open) return;
    }
  }

  _onFrame(fin, op, payload) {
    if (op === 0x8) { this._write(0x8, Buffer.alloc(0)); this.sock.end(); this._closed(); return; }
    if (op === 0x9) { this._write(0xA, payload); return; }
    if (op === 0xA) return;
    if (op === 0x1 || op === 0x2) {
      if (fin) this.emit('message', payload.toString('utf8'));
      else this.frag = [payload];
      return;
    }
    if (op === 0x0 && this.frag) {
      this.frag.push(payload);
      if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.emit('message', all.toString('utf8')); }
    }
  }

  _write(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([header, payload])); } catch (e) { this._closed(); }
  }

  send(text) { this._write(0x1, Buffer.from(text, 'utf8')); }
  ping() { this._write(0x9, Buffer.alloc(0)); }
  close() { this._write(0x8, Buffer.alloc(0)); try { this.sock.end(); } catch (e) {} this._closed(); }
  destroy() { try { this.sock.destroy(); } catch (e) {} this._closed(); }
}

function createServer(port, onConnection, log = console.log, onListening = null) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/whist')) {
      // Identity check used by the app's automatic server search.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify(createServer.info ? createServer.info() : { whist: 1 }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Whist server is running. Connect with the game app.\n');
  });
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onConnection(new Socket(sock), req);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${port} is already in use - is the server already running in another window?\n`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => (onListening || (() => log(`Whist server listening on port ${port}`)))());
  return server;
}

module.exports = { createServer };
