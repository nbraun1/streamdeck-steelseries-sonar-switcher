'use strict';

// Sets volume and mute of Windows audio endpoints (Sonar's virtual devices).
// Sonar picks these changes up like the Windows volume keys: it applies them
// to its audio engine and pushes them to the GG UI in real time, which its
// REST API does not do. Node has no Core Audio bindings, so a long-running
// PowerShell process (part of every Windows install) does the COM calls; it
// compiles a small C# class once and then reads one JSON command per line.

const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p);
    int UnregisterControlChangeNotify(IntPtr p);
    int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float l, ref Guid g);
    int SetMasterVolumeLevelScalar(float l, ref Guid g);
    int GetMasterVolumeLevel(out float l);
    int GetMasterVolumeLevelScalar(out float l);
    int SetChannelVolumeLevel(uint c, float l, ref Guid g);
    int SetChannelVolumeLevelScalar(uint c, float l, ref Guid g);
    int GetChannelVolumeLevel(uint c, out float l);
    int GetChannelVolumeLevelScalar(uint c, out float l);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice d);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

public static class SonarEndpoint {
    static IAudioEndpointVolume Open(string id) {
        var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice d;
        Marshal.ThrowExceptionForHR(e.GetDevice(id, out d));
        var iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
        return (IAudioEndpointVolume)o;
    }
    public static void SetVolume(string id, float v) {
        var ctx = Guid.Empty;
        Marshal.ThrowExceptionForHR(Open(id).SetMasterVolumeLevelScalar(v, ref ctx));
    }
    public static void SetMute(string id, bool m) {
        var ctx = Guid.Empty;
        Marshal.ThrowExceptionForHR(Open(id).SetMute(m, ref ctx));
    }
}
'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
    try {
        $c = $line | ConvertFrom-Json
        if ($c.cmd -eq 'volume') { [SonarEndpoint]::SetVolume($c.id, [float]$c.value) }
        elseif ($c.cmd -eq 'mute') { [SonarEndpoint]::SetMute($c.id, [bool]$c.muted) }
        [Console]::Out.WriteLine('ok')
    } catch {
        [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace '\s+', ' '))
    }
}
`;

const TIMEOUT_MS = 10000;

// The running helper: { proc, ready: Promise, pending: [reply callbacks in order] }
let helper = null;

function start() {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const h = { proc, pending: [] };
  let markReady;
  let failReady;
  h.ready = new Promise((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  h.ready.catch(() => {}); // nobody may be waiting when it fails

  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === 'ready') markReady();
      else if (line && h.pending.length) h.pending.shift()(line);
    }
  });

  let ended = false;
  const end = (reason) => {
    if (ended) return;
    ended = true;
    failReady(new Error(reason));
    for (const cb of h.pending.splice(0)) cb('error ' + reason);
    if (helper === h) helper = null;
  };
  proc.on('exit', (code) => end(`endpoint helper exited (${code})`));
  proc.on('error', (e) => end(`endpoint helper failed: ${e.message}`));
  proc.stdin.on('error', () => {}); // writing to a dead helper; reported via exit
  helper = h;
  return h;
}

// A helper that does not answer in time is killed, so the next call starts a fresh one.
function withTimeout(h, promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        h.proc.kill();
        reject(new Error(message));
      }, TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function send(command) {
  const h = helper || start();
  await withTimeout(h, h.ready, 'endpoint helper did not start');
  const reply = await withTimeout(
    h,
    new Promise((resolve) => {
      h.pending.push(resolve);
      h.proc.stdin.write(JSON.stringify(command) + '\n');
    }),
    'endpoint helper did not answer'
  );
  if (reply !== 'ok') throw new Error(reply.replace(/^error /, ''));
}

// Start the helper early so the first key press does not wait for it.
function warmUp() {
  if (!helper) start();
}

function setVolume(endpointId, volume) {
  return send({ cmd: 'volume', id: endpointId, value: Math.min(1, Math.max(0, volume)) });
}

function setMute(endpointId, muted) {
  return send({ cmd: 'mute', id: endpointId, muted: !!muted });
}

module.exports = { warmUp, setVolume, setMute };
