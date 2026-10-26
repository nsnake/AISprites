#!/usr/bin/env node
/*
 * web_client.js -- WebSocket subscriber + static server for the web display.
 *
 * Two jobs, deliberately separate:
 *
 *   1. Subscribe to the state server's /ws (the same endpoint the ESP32
 *      firmware subscribes to) and hold the session view upstream.
 *   2. Serve public/ and push every received frame to the browser over SSE.
 *
 * The browser never talks to the state server: it gets one view from this
 * process, so the page and the panel cannot diverge. That mirrors the
 * firmware, where ws.h is transport only and the session table lives in the
 * display layer.
 *
 * The state server's /ws is a long-lived subscription with no inactivity
 * timeout (Server.pm sets inactivity_timeout(0)); without it, quiet stretches
 * are read as a dead connection and the socket is closed with 1006. Keepalive
 * here is an empty frame every 20s, which also catches TCP half-open -- data
 * flows one way, so the kernel will not otherwise notice the peer is gone.
 * That is the same arrangement as ws_client.pl (which sends an empty Mojo
 * frame; the global WebSocket in Node has no ping()).
 *
 * Usage
 *   node web_client.js                                # :8991 -> 127.0.0.1:3000
 *   node web_client.js --port 8991 --server 192.168.3.201 --server-port 3000
 *
 *   --port PORT         port to serve the page on (default 8991)
 *   --server HOST       state server host (default 127.0.0.1)
 *   --server-port PORT  state server port (default 3000)
 *   --help              show this help
 *
 * Exit codes: 0 ok, 1 transport failure, 2 bad arguments.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');

const PING_INTERVAL_MS = 20000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
};

function usage(stream, code) {
  stream.write(
    'Usage: node web_client.js [options]\n' +
    '\n' +
    'Serve the Playcat AI Sprites web display and relay the state server\'s\n' +
    'WebSocket stream to browsers over SSE.\n' +
    '\n' +
    'Options:\n' +
    '  --port PORT         port to serve the page on (default 8991)\n' +
    '  --server HOST       state server host (default 127.0.0.1)\n' +
    '  --server-port PORT  state server port (default 3000)\n' +
    '  --help              show this help\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opt = { port: 8991, server: '127.0.0.1', serverPort: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(process.stdout, 0);
    else if (a === '--port') opt.port = nextArg(argv, i++);
    else if (a === '--server') opt.server = nextArg(argv, i++);
    else if (a === '--server-port') opt.serverPort = nextArg(argv, i++);
    else { process.stderr.write(`unknown argument: ${a}\n`); usage(process.stderr, 2); }
  }
  opt.port = Number(opt.port);
  opt.serverPort = Number(opt.serverPort);
  if (!Number.isInteger(opt.port) || opt.port <= 0 ||
      !Number.isInteger(opt.serverPort) || opt.serverPort <= 0) {
    process.stderr.write('ports must be positive integers\n');
    process.exit(2);
  }
  return opt;
}

function nextArg(argv, i) {
  const v = argv[i + 1];
  if (v === undefined) { process.stderr.write(`missing value for ${argv[i]}\n`); process.exit(2); }
  return v;
}

// --- SSE clients ---------------------------------------------------------
// Browsers reconnect on their own after a drop; on reconnect they get the
// current session snapshot again, so a missed event does not leave the page
// showing a stale view.

const clients = new Set();

function broadcast(frame) {
  const data = frame.replace(/[\r\n]/g, ' '); // one SSE frame = one event
  for (const res of clients) {
    res.write(`data: ${data}\n\n`);
  }
}

function attachSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    // Node buffers writes when piped; SSE must reach the browser immediately.
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n'); // reconnect attempt cadence
  clients.add(res);
  res.on('close', () => { clients.delete(res); });
}

// --- static files --------------------------------------------------------

function servePublic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Only files that exist under public/, and no '..' escape.
  const rel = path.normalize(urlPath).replace(/^\/+/, '');
  if (rel.includes('..')) { sendStatus(res, 403, 'forbidden'); return; }
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { sendStatus(res, 403, 'forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { sendStatus(res, 404, 'not found'); return; }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ||
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });
}

function sendStatus(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${code} ${msg}\n`);
}

// --- upstream WebSocket --------------------------------------------------
// Node 22+ has a global WebSocket, so no ws dependency. If this is ever
// unavailable, say so plainly rather than crash with a TypeError later.

function subscribe(opt) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('global WebSocket unavailable (need Node 22+)');
  }

  const url = `ws://${opt.server}:${opt.serverPort}/ws`;
  let ws;
  let pingTimer = null;
  let closedByUs = false;

  function connect() {
    if (closedByUs) return;
    log(`connecting ${url}`);
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      log(`connected ${url}`);
      // No WS-level keepalive from the server: an empty frame every 20s is
      // what detects a half-open TCP. Shorter than common NAT timeouts (most
      // 60s+), and short enough that a dead peer is noticed promptly.
      // An empty *text* frame rather than a WS ping: the global WebSocket in
      // Node has no ping(), and the server treats any message as traffic,
      // which is all the keepalive needs.
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('');
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', ev => {
      // The frame is the server's own JSON; hand it to the browser verbatim.
      // Parsing here would make this process an arbiter, which the
      // architecture forbids: the display decides what to show, not the
      // transport.
      const frame = typeof ev.data === 'string' ? ev.data : '';
      if (frame) broadcast(frame);
    });

    const onDrop = () => {
      clearInterval(pingTimer);
      if (closedByUs) return;
      // Reconnect with the same backoff as the firmware: 1s, doubling, 10s
      // cap. A flaky network should not hammer the server.
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      log(`upstream dropped; reconnecting in ${delay}ms`);
      setTimeout(connect, delay);
    };
    ws.addEventListener('close', onDrop);
    ws.addEventListener('error', () => {
      // 'close' always follows 'error' on a failed socket; keep this quiet.
    });
  }

  let delay = RECONNECT_MIN_MS;
  connect();

  return {
    close() {
      closedByUs = true;
      clearInterval(pingTimer);
      if (ws) ws.close();
    },
    isOpen() { return ws && ws.readyState === WebSocket.OPEN; }
  };
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

function log(msg) {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

// --- main ----------------------------------------------------------------

function main() {
  const opt = parseArgs(process.argv.slice(2));

  const server = http.createServer((req, res) => {
    if (req.url === '/events') { attachSSE(res); return; }
    servePublic(req, res);
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`port ${opt.port} already in use; pass --port\n`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(opt.port, () => {
    log(`serving http://127.0.0.1:${opt.port}/ (public/)`);
    subscribe(opt);
  });

  // Stop cleanly so the port and the WS subscription are released.
  process.on('SIGINT', () => {
    log('shutting down');
    server.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => process.exit(0));
}

main();
