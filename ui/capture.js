import { clock } from './model.js';
import { shortcutLabel } from './shortcuts.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const phase = document.querySelector('#capture-phase');
const time = document.querySelector('#capture-time');
const pause = document.querySelector('#capture-pause');
const stop = document.querySelector('#capture-stop');
const expand = document.querySelector('#capture-expand');
const error = document.querySelector('#capture-error');
const retry = document.querySelector('#capture-retry');
let status = { phase:'idle', elapsed_ms:0 }, pending = false, stopping = false, statusVersion = 0;
let listeningStatus = false, listeningRefresh = false;

function report(value) {
  const text = value ? String(value) : '';
  if (error.textContent !== text) error.textContent = text;
  error.hidden = !value;
}
function render(value) {
  status = value;
  if (status.phase === 'idle') stopping = false;
  const label = {idle:'Recording finished',preparing:'Preparing recording…',recording:'Recording',paused:'Paused',saving:'Saving recording…'}[status.phase] || 'Waiting for recording';
  if (phase.textContent !== label) phase.textContent = label;
  time.textContent = clock(status.elapsed_ms);
  pause.textContent = status.phase === 'paused' ? 'Resume' : 'Pause';
  pause.disabled = pending || stopping || !['recording','paused'].includes(status.phase);
  stop.disabled = pending || stopping || !['preparing','recording','paused'].includes(status.phase);
  if (status.error) report(status.error);
}
async function refresh() {
  const version = statusVersion;
  const data = await invoke('capture_controls_state');
  document.documentElement.dataset.theme = data.appearance.toLowerCase();
  pause.title = `Pause / resume: ${shortcutLabel(data.pause_hotkey)}`;
  stop.title = `Stop and save: ${shortcutLabel(data.stop_hotkey)}`;
  if (version === statusVersion) render(data.status);
  if (document.activeElement === retry) phase.focus();
  retry.hidden = true;
}
async function command(name) {
  if (pending) return;
  pending = true; report(); render(status);
  try {
    await invoke(name);
    if (name === 'stop_capture') stopping = true;
    await refresh();
  } catch (e) { report(e); retry.hidden = false; }
  finally { pending = false; render(status); }
}
pause.onclick = () => command('pause_capture');
stop.onclick = () => command('stop_capture');
expand.onclick = () => invoke('expand_capture').catch(report);
retry.onclick = async () => { report(); try { await main(); } catch(e) { report(e); } };
async function main() {
  if (!listeningStatus) {
    await listen('capture-status', e => { statusVersion++; render(e.payload); });
    listeningStatus = true;
  }
  if (!listeningRefresh) {
    await listen('capture-controls-refresh', () => { stopping = false; report(); refresh().catch(e => { report(e); retry.hidden = false; }); });
    listeningRefresh = true;
  }
  await refresh();
}
main().catch(e => { report(e); retry.hidden = false; });
