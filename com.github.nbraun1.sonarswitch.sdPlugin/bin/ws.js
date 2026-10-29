'use strict';

// Minimal WebSocket client (RFC 6455) for the Stream Deck connection.
// The Node 20 runtime bundled with Stream Deck has no global WebSocket, and
// this keeps the plugin free of npm dependencies.

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WebSocketClient extends EventEmitter {
  constructor(port) {
    super();
    this.buf = Buffer.alloc(0);
    this.open = false;
    this.fragments = [];

    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.connect(port, '127.0.0.1', () => {
      this.socket.write(
        'GET / HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    this.socket.on('data', (d) => this.onData(d));
    this.socket.on('close', () => {
      this.open = false;
      this.emit('close');
    });
    this.socket.on('error', (e) => this.emit('error', e));
  }

  onData(data) {
    this.buf = Buffer.concat([this.buf, data]);
    if (!this.open) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString();
      this.buf = this.buf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) {
        this.emit('error', new Error('WebSocket handshake failed: ' + head.split('\r\n')[0]));
        this.socket.destroy();
        return;
      }
      this.open = true;
      this.emit('open');
    }
    this.parseFrames();
  }

  parseFrames() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buf.length < offset + len) return;

      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < len; i++) payload[i] ^= this.buf[maskOffset + (i & 3)];
      }
      this.buf = this.buf.subarray(offset + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        return;
      case 0x9: // ping
        this.sendFrame(0xa, payload);
        return;
      case 0xa: // pong
        return;
      case 0x1:
      case 0x2:
        this.fragments = [payload];
        break;
      case 0x0:
        this.fragments.push(payload);
        break;
      default:
        return;
    }
    if (fin) {
      const message = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.emit('message', message);
    }
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendFrame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, body]));
  }
}

module.exports = { WebSocketClient };
