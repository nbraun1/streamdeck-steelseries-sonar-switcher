# Sonar Device Switcher for Stream Deck

Stream Deck plugin that sets the devices, volume and mute state of the
[SteelSeries GG Sonar](https://steelseries.com/gg/sonar) channels with one key press –
e.g. one key for your headset, one for your speakers.

## Features

- **One row per channel** (Master, Game, Chat, Media, Aux, Microphone) with device, mute button
  and volume slider.
- **All channels together** – one checkbox collapses Game, Chat, Media and Aux into an
  "All channels" row. Master and the microphone always keep their own row.
- **Applied on every key press:** all visible volumes and mute states. Mute defaults to
  unmuted, new sliders start at Sonar's current volume. Devices can be left on *don't change*.
- **Use current setup** fills the action from Sonar's current configuration.
- **Live in GG** – changes show up in the GG UI immediately.
- **Active indicator** – the key lights up while Sonar matches its profile.
- **Restore on startup** – the last applied setup is saved to
  `%APPDATA%\com.github.nbraun1.sonarswitch\state.json` and re-applied when Stream Deck starts
  (waits up to ~5 minutes for GG/Sonar).
- **English and German**, following Stream Deck's language (`de.json`, `ui/i18n.js`).

## Requirements

- Windows 10/11, Stream Deck 6.5+
- SteelSeries GG with Sonar in **classic** mode (streamer mode is not supported)

No dependencies: the plugin runs on Stream Deck's bundled Node.js and Windows PowerShell.

## Installation

Double-click the `.streamDeckPlugin` file from the releases page, or build it into `dist/`:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

For development, link the plugin folder and restart Stream Deck. The log is written to
`com.github.nbraun1.sonarswitch.sdPlugin/logs/plugin.log`.

```powershell
New-Item -ItemType Junction -Path "$env:APPDATA\Elgato\StreamDeck\Plugins\com.github.nbraun1.sonarswitch.sdPlugin" -Target "$PWD\com.github.nbraun1.sonarswitch.sdPlugin"
```

## How it works

GG writes its address to `%ProgramData%\SteelSeries\GG\coreProps.json`; its `/subApps` endpoint
returns the address of Sonar's local, undocumented HTTP API (it may change with GG updates):

| Purpose | Request |
| --- | --- |
| Mode | `GET /mode/` |
| Devices | `GET /audioDevices` |
| Device per channel | `GET`/`PUT /classicRedirections/{game\|chat\|media\|aux\|mic}/deviceId/{id}` |
| Volume and mute | `GET /volumeSettings/classic` |
| Set master | `PUT /volumeSettings/classic/Master/{Volume\|Mute}/{value}` |

Things the plugin works around:

- **Channel volume/mute go through Windows.** They are the Windows volume/mute of Sonar's
  virtual playback devices ("SteelSeries Sonar - Gaming", "- Chat", "- Media", "- Aux",
  "- Microphone"). Set that way – via a PowerShell helper using Core Audio – Sonar applies them
  at once and pushes them to GG (`SONAR_EVENT_VOLUME_DATA` on its `/sock` websocket). Sonar's
  REST endpoints (`…/{channel}/Volume|Mute/…`) only store the value silently; they are the
  fallback if the helper fails.
- **Master has no Windows device**, so it is set via REST, and the output channels are re-sent
  through Windows afterwards so GG receives the new master value.
- **Volumes are absolute.** Changing Master makes Sonar rescale the output channels, so Master
  is set first. GG shows output channels relative to Master, so its percentages can differ.
- **Device switches** rebuild a channel's audio path; mute/volume set meanwhile are not applied.
  The plugin only switches channels whose device changes, waits briefly, sets each volume via a
  1 % step (Sonar ignores a value equal to the stored one) and re-sends volumes after 1.5 s.

## License

[MIT](LICENSE). Not affiliated with SteelSeries or Elgato.
