'use strict';

/**
 * Bridge de teste do contrato JSON Lines. Não emula nada; apenas materializa
 * um arquivo de estado para exercitar o isolamento e o caminho canônico.
 */
const fs = require('node:fs');

let buffer = '';
let config = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.command === 'init') {
    config = message.payload;
    send({ id: 'init', ok: true, data: { ready: true } });
    return;
  }
  if (message.command === 'save-state') {
    fs.mkdirSync(require('node:path').dirname(message.path), { recursive: true });
    fs.writeFileSync(message.path, Buffer.from(`FAKE_STATE:${message.slot}:${config.sessionId}`));
    send({ id: message.id, ok: true, data: { saved: true } });
    return;
  }
  if (message.command === 'load-state') {
    const exists = fs.existsSync(message.path);
    fs.writeFileSync(`${config.stateDir}/last-load.txt`, message.path);
    send({
      id: message.id,
      ok: exists,
      data: { loaded: exists },
      error: exists ? undefined : { code: 'STATE_NOT_FOUND', message: 'missing' },
    });
    return;
  }
  if (message.command === 'pause' || message.command === 'resume') {
    send({ id: message.id, ok: true, data: { command: message.command } });
    return;
  }
  if (message.command === 'quit') {
    send({ id: message.id, ok: true, data: { bye: true } });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  send({ id: message.id, ok: false, error: { code: 'UNKNOWN', message: message.command } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
