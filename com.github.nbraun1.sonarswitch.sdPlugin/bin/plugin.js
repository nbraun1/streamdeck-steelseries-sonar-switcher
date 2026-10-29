'use strict';

const { WebSocketClient } = require('./ws');
const { log } = require('./log');
const sonar = require('./sonar');
const store = require('./store');
const { buildPlan, normalizeSettings } = require('./settings');

const PROFILE_ACTION = 'com.github.nbraun1.sonarswitch.profile';
const POLL_INTERVAL_MS = 3000;
const SETTLE_RESEND_MS = 1500;
const RESTORE_RETRY_MS = 5000;
const RESTORE_MAX_ATTEMPTS = 60; // GG may start after Stream Deck; keep trying for ~5 minutes

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (e) => log('uncaughtException', e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', (e && e.stack) || e));

// ---------------------------------------------------------------- Stream Deck connection

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^-/, '')] = argv[i + 1];
  return out;
}

const args = parseArgs(process.argv.slice(2));
const ws = new WebSocketClient(Number(args.port));
sonar.warmUp();

function send(event, context, payload, action) {
  const msg = { event, context };
  if (action) msg.action = action;
  if (payload !== undefined) msg.payload = payload;
  ws.send(JSON.stringify(msg));
}

ws.on('open', () => {
  ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
  log('registered with Stream Deck');
  restoreOnStartup();
});
ws.on('close', () => {
  log('Stream Deck connection closed');
  process.exit(0);
});
ws.on('error', (e) => log('websocket error', e));
ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  handleEvent(msg).catch((e) => log('handler error', msg.event, e.stack || e));
});

// ---------------------------------------------------------------- applying plans

// Applying a plan takes several requests (and seconds after a device switch);
// running two at once would interleave them, so they run one after another.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function isEmpty(plan) {
  return ['devices', 'mute', 'volume'].every((k) => Object.keys(plan[k] || {}).length === 0);
}

// Saved device ids can go stale (e.g. driver reinstall); fall back to the saved name.
function resolveDevice(id, list, names) {
  if (list.some((d) => d.id === id)) return list.find((d) => d.id === id);
  const name = names && names[id];
  const byName = name && list.find((d) => d.name === name);
  if (byName) return byName;
  throw new sonar.SonarError('DEVICE_NOT_FOUND', `Device not found: ${name || id}`, { device: name || id });
}

function unsupportedMode(mode) {
  return new sonar.SonarError('UNSUPPORTED_MODE', `Sonar is in "${mode}" mode - only classic mode is supported`, { mode });
}

// Applies a plan to Sonar. Returns what was applied (with resolved device ids)
// and the names of the devices used. With skipMissing, devices that are not
// available are left out instead of failing the whole plan.
async function applyPlan(plan, names, { skipMissing = false } = {}) {
  const mode = await sonar.getMode();
  if (mode !== 'classic') throw unsupportedMode(mode);

  const [devices, current] = await Promise.all([sonar.getAudioDevices(), sonar.getState()]);
  const applied = { devices: {}, mute: { ...plan.mute }, volume: { ...plan.volume } };
  const appliedNames = {};

  // Only switch channels whose device actually changes: a switch rebuilds the
  // channel's audio path.
  const switched = [];
  for (const [ch, id] of Object.entries(plan.devices)) {
    let device;
    try {
      device = resolveDevice(id, ch === 'mic' ? devices.inputs : devices.outputs, names);
    } catch (e) {
      if (!skipMissing) throw e;
      log(`skipping ${ch}:`, e);
      continue;
    }
    if (current.devices[ch] !== device.id) {
      await sonar.setDevice(ch, device.id);
      switched.push(ch);
    }
    applied.devices[ch] = device.id;
    appliedNames[device.id] = device.name;
  }

  if (switched.length > 0) await sonar.waitForRedirections(switched);
  await sonar.setMuteAndVolume({ mute: plan.mute, volume: plan.volume, current, virtual: devices.virtual });

  // After a device switch, send the volumes once more in case the audio path
  // was still settling the first time.
  if (switched.length > 0 && Object.keys(plan.volume).length > 0) {
    await sleep(SETTLE_RESEND_MS);
    await sonar.setMuteAndVolume({ mute: {}, volume: plan.volume, current: await sonar.getState(), virtual: devices.virtual });
  }
  return { applied, names: appliedNames };
}

let restoreCancelled = false;

function applyProfile(context, settings) {
  // A key press wins over a restore that is still waiting for GG/Sonar.
  restoreCancelled = true;
  return exclusive(async () => {
    const { applied, names } = await applyPlan(buildPlan(settings), settings.names);
    try {
      store.record(applied, names);
    } catch (e) {
      log('could not save state:', e);
    }
    log('applied', context, applied);
  });
}

// Errors worth retrying while GG/Sonar is still starting up.
function isRetryable(e) {
  if (!(e instanceof sonar.SonarError)) return !/HTTP \d{3}/.test(e.message);
  return ['GG_NOT_FOUND', 'GG_NOT_RUNNING', 'SONAR_NOT_READY'].includes(e.code);
}

// Re-apply the setup stored by the last key presses, waiting for GG/Sonar if needed.
async function restoreOnStartup() {
  const saved = store.load();
  const plan = { devices: saved.devices, mute: saved.mute, volume: saved.volume };
  if (isEmpty(plan)) {
    log('nothing to restore');
    return;
  }
  for (let attempt = 1; attempt <= RESTORE_MAX_ATTEMPTS; attempt++) {
    try {
      const done = await exclusive(async () => {
        if (restoreCancelled) return false;
        await applyPlan(plan, saved.names, { skipMissing: true });
        return true;
      });
      log(done ? `restored state from ${store.STATE_FILE}` : 'restore skipped: a key was pressed', plan);
      refreshStates();
      return;
    } catch (e) {
      if (!isRetryable(e)) {
        log('restore failed:', e);
        return;
      }
      if (attempt === 1) log('restore waiting for Sonar:', e);
      await sleep(RESTORE_RETRY_MS);
    }
  }
  log('giving up on restoring state');
}

// ---------------------------------------------------------------- key state

// context -> { settings, state, lastError }
const visible = new Map();

function matches(plan, current) {
  if (isEmpty(plan)) return false;
  for (const [ch, id] of Object.entries(plan.devices)) if (current.devices[ch] !== id) return false;
  for (const [ch, muted] of Object.entries(plan.mute)) if (current.mute[ch] !== muted) return false;
  for (const [ch, volume] of Object.entries(plan.volume)) {
    if (current.volume[ch] === undefined || Math.abs(current.volume[ch] - volume) > 0.006) return false;
  }
  return true;
}

function setKeyState(context, state) {
  const entry = visible.get(context);
  if (!entry || entry.state === state) return;
  entry.state = state;
  send('setState', context, { state });
}

// Light the key (state 1) while Sonar's current setup matches the profile.
let polling = false;
let lastPollError = null;
async function refreshStates() {
  if (polling || visible.size === 0) return;
  polling = true;
  try {
    const current = await sonar.getState();
    lastPollError = null;
    for (const [context, entry] of visible) setKeyState(context, matches(buildPlan(entry.settings), current) ? 1 : 0);
  } catch (e) {
    if (lastPollError !== e.message) log('poll failed:', e);
    lastPollError = e.message;
    for (const context of visible.keys()) setKeyState(context, 0);
  } finally {
    polling = false;
  }
}

setInterval(refreshStates, POLL_INTERVAL_MS);

// ---------------------------------------------------------------- property inspector

// Error as sent to the property inspector, which shows it in Stream Deck's language.
function toInspectorError(e) {
  return { code: e.code || 'UNKNOWN', params: e.params || {}, message: e.message };
}

// Device lists, Sonar's current setup and the last error a key press ran into.
async function inspectorData(context) {
  const entry = visible.get(context);
  const lastError = entry && entry.lastError ? toInspectorError(entry.lastError) : null;
  try {
    const [mode, { outputs, inputs }, current] = await Promise.all([sonar.getMode(), sonar.getAudioDevices(), sonar.getState()]);
    const error = mode !== 'classic' ? toInspectorError(unsupportedMode(mode)) : null;
    return { type: 'devices', mode, outputs, inputs, current, error, lastError };
  } catch (e) {
    return { type: 'devices', error: toInspectorError(e), lastError, outputs: [], inputs: [] };
  }
}

// ---------------------------------------------------------------- events

// Settings in the current format; migrated settings are stored back once.
function currentSettings(context, raw) {
  const { settings, changed } = normalizeSettings(raw);
  if (changed) {
    send('setSettings', context, settings);
    log('migrated settings', context);
  }
  return settings;
}

async function handleEvent(msg) {
  const { event, context, action, payload } = msg;
  if (action && action !== PROFILE_ACTION) return;

  switch (event) {
    case 'willAppear':
      visible.set(context, { settings: currentSettings(context, payload.settings), state: payload.state });
      refreshStates();
      break;

    case 'willDisappear':
      visible.delete(context);
      break;

    case 'didReceiveSettings':
      if (visible.has(context)) visible.get(context).settings = currentSettings(context, payload.settings);
      refreshStates();
      break;

    case 'keyUp': {
      const entry = visible.get(context);
      try {
        await applyProfile(context, normalizeSettings(payload.settings).settings);
        if (entry) entry.lastError = null;
        send('showOk', context);
      } catch (e) {
        log('apply failed:', e);
        if (entry) entry.lastError = e;
        send('showAlert', context);
      }
      refreshStates();
      break;
    }

    case 'sendToPlugin':
      if (payload && payload.cmd === 'getDevices') {
        send('sendToPropertyInspector', context, await inspectorData(context), action);
      }
      break;
  }
}
