// Property inspector translations. English is the default and the fallback
// for every key; the language follows Stream Deck's application language.

const STRINGS = {
  en: {
    'status.connecting': 'Connecting …',
    'status.loading': 'Loading devices …',
    'status.connected': 'Connected (classic mode)',
    'same': 'Set all channels together',
    'channel.master': 'Master',
    'channel.all': 'All channels',
    'channel.game': 'Game',
    'channel.chat': 'Chat',
    'channel.media': 'Media',
    'channel.aux': 'Aux',
    'channel.mic': 'Microphone',
    'mute.unmute': 'Unmuted – click to mute',
    'mute.mute': 'Muted – click to unmute',
    'device.keep': '— don’t change —',
    'device.inactive': '(inactive)',
    'device.unavailable': '(unavailable)',
    'tools.refresh': 'Reload devices',
    'tools.takeCurrent': 'Use current setup',
    'tools.hint':
      '“Reload devices” fetches the current device list from Sonar. “Use current setup” fills all fields with Sonar’s current devices, mute states and volumes.',
    'lastError': 'Last key press failed: {message}',
    'error.GG_NOT_FOUND': 'SteelSeries GG not found',
    'error.GG_NOT_RUNNING': 'SteelSeries GG is not running',
    'error.SONAR_DISABLED': 'Sonar is disabled in SteelSeries GG',
    'error.SONAR_NOT_READY': 'Sonar is not running yet',
    'error.UNSUPPORTED_MODE': '“{mode}” mode – only classic mode is supported',
    'error.DEVICE_NOT_FOUND': 'Device not found: {device}',
    'error.UNKNOWN': 'Error: {message}',
  },
  de: {
    'status.connecting': 'Verbinde …',
    'status.loading': 'Lade Geräte …',
    'status.connected': 'Verbunden (Classic-Modus)',
    'same': 'Alle Kanäle gemeinsam einstellen',
    'channel.all': 'Alle Kanäle',
    'channel.mic': 'Mikrofon',
    'mute.unmute': 'Nicht stumm – klicken zum Stummschalten',
    'mute.mute': 'Stumm – klicken zum Lautschalten',
    'device.keep': '— nicht ändern —',
    'device.inactive': '(inaktiv)',
    'device.unavailable': '(nicht verfügbar)',
    'tools.refresh': 'Geräte neu laden',
    'tools.takeCurrent': 'Aktuellen Stand übernehmen',
    'tools.hint':
      '„Geräte neu laden“ holt die aktuelle Geräteliste von Sonar. „Aktuellen Stand übernehmen“ füllt alle Felder mit den aktuellen Geräten, Stummschaltungen und Lautstärken aus Sonar.',
    'lastError': 'Letzter Tastendruck fehlgeschlagen: {message}',
    'error.GG_NOT_FOUND': 'SteelSeries GG nicht gefunden',
    'error.GG_NOT_RUNNING': 'SteelSeries GG läuft nicht',
    'error.SONAR_DISABLED': 'Sonar ist in SteelSeries GG deaktiviert',
    'error.SONAR_NOT_READY': 'Sonar läuft noch nicht',
    'error.UNSUPPORTED_MODE': 'Modus „{mode}“ – nur der Classic-Modus wird unterstützt',
    'error.DEVICE_NOT_FOUND': 'Gerät nicht gefunden: {device}',
    'error.UNKNOWN': 'Fehler: {message}',
  },
};

let language = 'en';

// Stream Deck reports codes like "en", "de", "zh_CN".
function setLanguage(code) {
  const base = String(code || '').split(/[-_]/)[0].toLowerCase();
  language = STRINGS[code] ? code : STRINGS[base] ? base : 'en';
  document.documentElement.lang = language;
}

function t(key, params = {}) {
  const text = (STRINGS[language] && STRINGS[language][key]) || STRINGS.en[key] || key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (params[name] !== undefined ? params[name] : ''));
}

// Plugin errors arrive as { code, params, message }.
function translateError(error) {
  const key = 'error.' + error.code;
  return STRINGS.en[key] ? t(key, { ...error.params, message: error.message }) : t('error.UNKNOWN', { message: error.message });
}

function translatePage() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}
