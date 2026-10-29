'use strict';

// Persists the Sonar setup last applied by the plugin so it can be restored
// when Stream Deck (and with it the plugin) starts again. The file lives
// outside the plugin folder so it survives plugin updates.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'com.github.nbraun1.sonarswitch',
  'state.json'
);

function emptyState() {
  return { devices: {}, mute: {}, volume: {}, names: {}, updatedAt: null };
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...emptyState(), ...data };
  } catch {
    return emptyState();
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Merge an applied plan into the stored state. Profiles may only touch some
// channels, so the result is the combined effect of all applied profiles.
// names: device id -> friendly name, used to find a device again if its id changes.
function record(plan, names) {
  const state = load();
  Object.assign(state.devices, plan.devices);
  Object.assign(state.mute, plan.mute);
  Object.assign(state.volume, plan.volume);
  // Keep names of devices set by earlier profiles, drop names no longer used.
  const known = { ...state.names, ...names };
  state.names = {};
  for (const id of Object.values(state.devices)) {
    if (known[id]) state.names[id] = known[id];
  }
  state.updatedAt = new Date().toISOString();
  save(state);
  return state;
}

module.exports = { STATE_FILE, load, record };
