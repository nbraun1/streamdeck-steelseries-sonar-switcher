'use strict';

// Client for the local SteelSeries GG / Sonar web API.
// GG writes its HTTPS address to coreProps.json; its /subApps endpoint tells
// us where the Sonar web server currently listens (the port changes on every
// GG start, so the address is re-discovered whenever a request fails).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const endpoint = require('./endpoint');
const { log } = require('./log');

const CORE_PROPS = path.join(process.env.ProgramData || 'C:\\ProgramData', 'SteelSeries', 'GG', 'coreProps.json');
const REQUEST_TIMEOUT_MS = 3000;

const OUTPUT_CHANNELS = ['game', 'chat', 'media', 'aux'];
const CHANNELS = ['master', ...OUTPUT_CHANNELS, 'mic'];

// Channel name in /volumeSettings, which is also the role of the channel's
// virtual playback device in /audioDevices (master has none).
const SONAR_IDS = {
  master: 'Master',
  game: 'game',
  chat: 'chatRender',
  media: 'media',
  aux: 'aux',
  mic: 'chatCapture',
};

class HttpError extends Error {}

// Error with a stable code the property inspector translates for the user.
class SonarError extends Error {
  constructor(code, message, params = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- HTTP

function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, timeout: REQUEST_TIMEOUT_MS, rejectUnauthorized: false, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new HttpError(`${method} ${u.pathname} -> HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch {
            resolve(body);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout: ${method} ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

let baseUrl = null;

async function discover() {
  let props;
  try {
    props = JSON.parse(fs.readFileSync(CORE_PROPS, 'utf8'));
  } catch {
    throw new SonarError('GG_NOT_FOUND', 'SteelSeries GG not found (coreProps.json is missing)');
  }
  const gg = await request(`https://${props.ggEncryptedAddress}/subApps`).catch(() => {
    throw new SonarError('GG_NOT_RUNNING', 'SteelSeries GG is not running');
  });
  const sonar = gg && gg.subApps && gg.subApps.sonar;
  if (!sonar || !sonar.isEnabled) throw new SonarError('SONAR_DISABLED', 'Sonar is disabled in SteelSeries GG');
  if (!sonar.isReady || !sonar.isRunning || !sonar.metadata || !sonar.metadata.webServerAddress) {
    throw new SonarError('SONAR_NOT_READY', 'Sonar is not running yet');
  }
  baseUrl = sonar.metadata.webServerAddress.replace(/\/+$/, '');
}

async function call(method, urlPath) {
  if (!baseUrl) await discover();
  try {
    return await request(baseUrl + urlPath, method);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Connection problem: GG/Sonar was probably restarted on a new port.
    await discover();
    return request(baseUrl + urlPath, method);
  }
}

// ---------------------------------------------------------------- reading

async function getMode() {
  return call('GET', '/mode/');
}

// Physical devices for the device lists, and the ids of Sonar's virtual
// playback device per channel (used to set volume and mute through Windows).
async function getAudioDevices() {
  const list = (await call('GET', '/audioDevices')) || [];
  const physical = list
    .filter((d) => !d.isVad && d.role === 'none')
    .map((d) => ({
      id: d.id,
      name: d.friendlyName,
      flow: d.dataFlow === 'capture' ? 'input' : 'output',
      active: d.state === 'active',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const virtual = {};
  for (const ch of CHANNELS) {
    const d = list.find((x) => x.isVad && x.dataFlow === 'render' && x.role === SONAR_IDS[ch]);
    if (d) virtual[ch] = d.id;
  }

  return {
    outputs: physical.filter((d) => d.flow === 'output'),
    inputs: physical.filter((d) => d.flow === 'input'),
    virtual,
  };
}

// Current device, mute state and absolute volume (0..1) per channel (classic mode).
async function getState() {
  const [redirections, settings] = await Promise.all([
    call('GET', '/classicRedirections'),
    call('GET', '/volumeSettings/classic'),
  ]);
  const devices = {};
  for (const r of redirections || []) devices[r.id] = r.deviceId;

  const mute = {};
  const volume = {};
  for (const ch of CHANNELS) {
    const entry = ch === 'master' ? settings && settings.masters : settings && settings.devices && settings.devices[SONAR_IDS[ch]];
    const classic = (entry && entry.classic) || {};
    mute[ch] = !!classic.muted;
    if (typeof classic.volume === 'number') volume[ch] = classic.volume;
  }
  return { devices, mute, volume };
}

// ---------------------------------------------------------------- devices

// channel: game | chat | media | aux | mic
async function setDevice(channel, deviceId) {
  return call('PUT', `/classicRedirections/${channel}/deviceId/${encodeURIComponent(deviceId)}`);
}

// Switching a device rebuilds Sonar's audio path for the channel; mute and
// volume set before it runs again are stored but not applied. isRunning turns
// true before the path is fully rebuilt, so wait a moment longer.
async function waitForRedirections(channels, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await call('GET', '/classicRedirections')) || [];
    if (channels.every((ch) => list.some((r) => r.id === ch && r.isRunning))) break;
    await sleep(150);
  }
  await sleep(800);
}

// ---------------------------------------------------------------- mute and volume
//
// Channel volume and mute are the Windows volume/mute of Sonar's virtual
// playback device for that channel ("SteelSeries Sonar - Gaming" etc.). Setting
// them through Windows makes Sonar apply them right away and push them to the
// GG UI (SONAR_EVENT_VOLUME_DATA); the REST API only stores them silently and
// is the fallback. Master has no Windows device and goes through REST.

const rest = {
  mute: (ch, muted) => call('PUT', `/volumeSettings/classic/${SONAR_IDS[ch]}/Mute/${muted ? 'true' : 'false'}`),
  volume: (ch, value) => call('PUT', `/volumeSettings/classic/${SONAR_IDS[ch]}/Volume/${clamp(value)}`),
};

// Sonar does not pass a value equal to the stored one on to its audio engine,
// so a value that is stored but not active (e.g. after a device switch) would
// never take effect. Setting a slightly different value first forces it; the
// step is inaudible.
const nudged = (value) => (value >= 0.5 ? value - 0.01 : value + 0.01);

async function channelVolume(virtual, ch, volume) {
  const value = clamp(volume);
  if (virtual[ch]) {
    try {
      await endpoint.setVolume(virtual[ch], nudged(value));
      await endpoint.setVolume(virtual[ch], value);
      return;
    } catch (e) {
      log(`windows volume for ${ch} failed, using REST:`, e);
    }
  }
  await rest.volume(ch, nudged(value));
  await rest.volume(ch, value);
}

async function channelMute(virtual, ch, muted) {
  if (virtual[ch]) {
    try {
      await endpoint.setMute(virtual[ch], muted);
      return;
    } catch (e) {
      log(`windows mute for ${ch} failed, using REST:`, e);
    }
  }
  await rest.mute(ch, muted);
}

// mute: {channel: bool}, volume: {channel: absolute 0..1}, current: getState()
// result, virtual: getAudioDevices().virtual.
async function setMuteAndVolume({ mute, volume, current, virtual }) {
  // Master first: Sonar rescales the output channels when it changes, so the
  // channels set afterwards end up at their absolute values. Only touch it if
  // it actually changes, because GG has to be told separately (see below).
  let masterChanged = false;
  if (mute.master !== undefined && mute.master !== current.mute.master) {
    await rest.mute('master', mute.master);
    masterChanged = true;
  }
  if (volume.master !== undefined && Math.abs(volume.master - (current.volume.master ?? -1)) > 0.001) {
    await rest.volume('master', volume.master);
    masterChanged = true;
  }

  const channels = CHANNELS.filter((ch) => ch !== 'master');
  for (const ch of channels) if (mute[ch] !== undefined) await channelMute(virtual, ch, mute[ch]);
  for (const ch of channels) if (volume[ch] !== undefined) await channelVolume(virtual, ch, volume[ch]);

  // GG only hears about master through the channel events; output channels the
  // profile did not set were also rescaled silently. Re-send them through Windows.
  if (masterChanged) {
    const after = await getState();
    for (const ch of OUTPUT_CHANNELS) {
      if (volume[ch] === undefined && after.volume[ch] !== undefined) await channelVolume(virtual, ch, after.volume[ch]);
    }
  }
}

module.exports = {
  SonarError,
  OUTPUT_CHANNELS,
  CHANNELS,
  getMode,
  getAudioDevices,
  getState,
  setDevice,
  waitForRedirections,
  setMuteAndVolume,
  warmUp: endpoint.warmUp,
};
