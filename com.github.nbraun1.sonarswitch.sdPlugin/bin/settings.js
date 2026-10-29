'use strict';

// Action settings as stored by the property inspector, and how they turn into
// a plan of what to set in Sonar.
//
//   sameOutput         true: rows master, all, mic; false: master, game, chat, media, aux, mic
//   output / out_<ch>  device id for the "all" row / a single output channel ('' = keep)
//   mic                input device id ('' = keep)
//   mute_<row>         'mute' | anything else = unmuted; always applied
//   vol_<row>          volume in percent; always applied once set
//   names              device id -> name, to find a device again if its id changes

const { OUTPUT_CHANNELS, CHANNELS } = require('./sonar');

// Volume in percent -> 0..1, or undefined if the row has no volume yet
// (Sonar's current volume is kept then).
function volumeOf(s, row) {
  const raw = s[`vol_${row}`];
  if (raw === undefined || raw === '') return undefined;
  const pct = Number(raw);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) / 100 : undefined;
}

// plan: { devices: {channel: id}, mute: {channel: bool}, volume: {channel: 0..1} }
function buildPlan(s) {
  const same = s.sameOutput !== false;

  const devices = {};
  for (const ch of OUTPUT_CHANNELS) {
    const id = same ? s.output : s[`out_${ch}`];
    if (id) devices[ch] = id;
  }
  if (s.mic) devices.mic = s.mic;

  // The "all" row stands for the four output channels.
  const rows = same ? { master: ['master'], all: OUTPUT_CHANNELS, mic: ['mic'] } : Object.fromEntries(CHANNELS.map((ch) => [ch, [ch]]));
  const mute = {};
  const volume = {};
  for (const [row, channels] of Object.entries(rows)) {
    const v = volumeOf(s, row);
    for (const ch of channels) {
      mute[ch] = s[`mute_${row}`] === 'mute';
      if (v !== undefined) volume[ch] = v;
    }
  }
  return { devices, mute, volume };
}

// ---------------------------------------------------------------- migration of pre-release settings

// Global controlMute/controlVolume/sameVolume switches with boolean mute_<ch>
// became per-row settings.
function migrateGlobalSwitches(s) {
  if (!('controlMute' in s) && !('controlVolume' in s) && !('sameVolume' in s)) return s;

  const muteOf = {};
  const volOf = {};
  for (const ch of CHANNELS) {
    muteOf[ch] = s.controlMute && s[`mute_${ch}`] ? 'mute' : 'unmute';
    if (!s.controlVolume) continue;
    const row = ch === 'master' || s.sameVolume === false ? ch : 'all';
    if (s[`volOn_${row}`]) volOf[ch] = s[`vol_${row}`] === undefined ? 100 : Number(s[`vol_${row}`]);
  }

  const n = { ...s };
  for (const key of ['controlMute', 'controlVolume', 'sameVolume']) delete n[key];
  for (const key of Object.keys(n)) if (/^(mute_|volOn_|vol_)/.test(key)) delete n[key];

  const setRow = (row, ch) => {
    n[`mute_${row}`] = muteOf[ch];
    if (volOf[ch] !== undefined) n[`vol_${row}`] = volOf[ch];
  };
  setRow('master', 'master');
  setRow('mic', 'mic');

  // The "all" row can only express identical mute/volume for the output channels.
  const likeGame = (ch) => muteOf[ch] === muteOf.game && volOf[ch] === volOf.game;
  if (n.sameOutput !== false && OUTPUT_CHANNELS.every(likeGame)) {
    setRow('all', 'game');
  } else {
    if (n.sameOutput !== false) {
      for (const ch of OUTPUT_CHANNELS) n[`out_${ch}`] = n.output || '';
      n.sameOutput = false;
    }
    for (const ch of OUTPUT_CHANNELS) setRow(ch, ch);
  }
  return n;
}

// Each volume slider had a "change volume" checkbox (volOn_<row>). Volumes are
// always applied now, so a switched-off slider loses its value: the row keeps
// Sonar's volume until the property inspector fills it in.
function migrateVolumeSwitches(s) {
  if (!Object.keys(s).some((key) => key.startsWith('volOn_'))) return s;
  const n = { ...s };
  for (const key of Object.keys(s)) {
    if (!key.startsWith('volOn_')) continue;
    if (!s[key]) delete n[key.replace('volOn_', 'vol_')];
    delete n[key];
  }
  return n;
}

// Returns the settings in the current format; `changed` tells whether they
// need to be stored back.
function normalizeSettings(settings) {
  const s = settings || {};
  const n = migrateVolumeSwitches(migrateGlobalSwitches(s));
  return { settings: n, changed: n !== s };
}

module.exports = { buildPlan, normalizeSettings };
