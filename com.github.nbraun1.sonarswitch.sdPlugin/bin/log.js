'use strict';

// Plain text log next to the plugin; it is cleared on every plugin start.

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'plugin.log');

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, '');
} catch {}

function format(part) {
  if (part instanceof Error) return part.message;
  return typeof part === 'string' ? part : JSON.stringify(part);
}

function log(...parts) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${parts.map(format).join(' ')}\n`);
  } catch {}
}

module.exports = { log };
