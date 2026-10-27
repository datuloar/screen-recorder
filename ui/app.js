import { t, errorText, configureLanguage, locale, translateShell } from './i18n.js';
import { clone, duration, sourceTime, editedTime, editTimeline, splitTimeline, snapTime, seconds, clock, fitRegion, dragRegion } from './model.js';
import { Timeline } from './timeline.js';
import { CropEditor } from './crop.js';
import { shortcutActions, shortcutLabel, shortcutConflict, recordShortcut, keyboardCode } from './shortcuts.js';

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = selector => document.querySelector(selector);
const content = $('#content');
const notice = $('#notice');
let settings, displays = [], systemDevices = [], micDevices = [], region, selectedDisplay, page = 'home', editor;
let phase = 'idle', countdown, countTimer, lastStatus, starting = false, cancelCountdown;
let recordings = [], jobBusy=false;
let systemLanguage=navigator.language;
configureLanguage(new URLSearchParams(location.search).get('language') || 'System');
translateShell();

function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'aria-label' || key === 'title') element.setAttribute(key,t(value));
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of [children].flat(Infinity)) if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
function button(label, action, primary = false) { return node('button', { text: t(label), class: primary ? 'primary' : '', onclick: () => safely(action) }); }
function field(label, input) { label=t(label);input.setAttribute('aria-label',label);return node('label', { class: 'field' }, [node('span', { text: label }), input]); }
function toolSection(title, children, open = false) { return node('details',{class:'edit-tool',open},[node('summary',{text:t(title)}),node('div',{class:'tool-body'},children)]); }
function check(label, value, change) { return node('label', {class:'check-control'}, [node('input', { type: 'checkbox', checked: value, onchange: e => change(e.target.checked) }), node('span',{text:t(label)})]); }
function number(value, min = 0, max = 100, step = 1) { return node('input', { type: 'number', value, min, max, step, required: true }); }
function select(options, value, change) {
  const input = node('select', { onchange: e => change?.(e.target.value) }, options.map(([id, label]) => node('option', { value: id, text: label })));
  input.value = value; return input;
}
function message(text = '', success = false) { notice.textContent = errorText(text); notice.hidden = !text; notice.classList.toggle('success', success); }
async function safely(action) { try { await action(); } catch (e) { message(String(e)); } }
function theme() { document.documentElement.dataset.theme = settings.appearance.toLowerCase(); }
function shortcutHint() { $('#footer-hint').textContent = t('Select area: {select} · stop: {stop}',{select:shortcutLabel(settings.hotkey),stop:shortcutLabel(settings.stop_hotkey)}); }
function applyLanguage(){configureLanguage(settings.language,systemLanguage);translateShell();}
function displayLabel(display){const number=/^Display (\d+)$/.exec(display.name)?.[1];return number?t('Display {number}',{number}):display.name;}
function audioLabel(track){return track?.id.startsWith('embedded:')?t('Video audio {number}',{number:track.stream+1}):t(track?.label || 'Track unavailable');}
function activeNav() { for (const id of ['home', 'settings','recordings']) { const n = $(`#${id}-nav`); if (page === id) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); } }
function showPage(next) {
  editor?.cropEditor?.close();
  if (editor) editor.pause();
  if(next!=='editor')editor?.timeline?.destroy();
  page = next; content.dataset.page = next; activeNav();
  if (next === 'home') renderHome();
  else if (next === 'settings') renderSettings();
  else if (next === 'editor') editor.mount();
  else if (next === 'recordings') renderRecordings();
  window.scrollTo(0,0);
}

function setJobBusy(value){jobBusy=value;document.querySelectorAll('nav button').forEach(b=>b.disabled=value);}
function requireIdle() {
  if (phase !== 'idle' || countdown || starting || jobBusy || editor?.busy) throw Error(t('Wait for the current operation to finish'));
}
async function navigate(next) {
  requireIdle();
  await editor?.flush();
  if (next === 'recordings') await refreshRecordings();
  else showPage(next);
}
async function openPending() {
  requireIdle();
  await editor?.flush();
  setJobBusy(true);
  try { const document = await invoke('open_pending'); if (document) acceptDocument(document); }
  finally { setJobBusy(false); }
}
function acceptDocument(document){editor?.destroy();editor=new Editor(document);showPage('editor');}
async function refreshRecordings(){
  if(phase!=='idle' || countdown || jobBusy || editor?.busy)throw Error(t('Wait for the current operation to finish'));
  await editor?.flush();showPage('recordings');
  const loading=node('p',{text:t('Loading recordings…'),'aria-live':'polite'});content.append(loading);
  try{recordings=await invoke('recent_recordings');if(page==='recordings' && !jobBusy)renderRecordings();}finally{loading.remove();}
}
function renderRecordings(){
  const header=node('div',{class:'page-heading'},[node('div',{},[node('h1',{text:t('Recordings')}),node('p',{class:'muted',text:t('Continue editing or recover an interrupted recording.')})]),button('Refresh',refreshRecordings)]);
  content.replaceChildren(header);
  if(!recordings.length){content.append(node('section',{class:'empty-state'},[node('h2',{text:t('Your recordings will appear here')}),node('p',{class:'muted',text:t('Select an area to record. Stop recording to open it in the editor.')}),button('Record screen',()=>navigate('home'),true)]));return;}
  const list=node('div',{class:'recording-list'});
  for(const recording of recordings){
    const date=recording.started_ms?new Date(recording.started_ms).toLocaleString(locale(),{dateStyle:'medium',timeStyle:'short'}):recording.id;
    const open=async id=>{requireIdle();await editor?.flush();setJobBusy(true);try{const document=await invoke('open_recording',{id});acceptDocument(document);}finally{setJobBusy(false);}};
    const recover=async()=>{
      requireIdle();await editor?.flush();setJobBusy(true);
      const progress=node('section',{class:'panel spaced','aria-live':'polite'},[node('h2',{text:t('Recovering complete fragments into a separate copy…')}),node('progress',{'aria-label':'Recording recovery'}),button('Cancel recovery',()=>invoke('cancel_recovery'))]);
      content.querySelectorAll('button').forEach(b=>b.disabled=true);content.append(progress);
      try{const document=await invoke('recover_entry',{id:recording.id});acceptDocument(document);message('Recovered copy is ready. The original is unchanged.',true);}
      catch(error){message(String(error));recordings=await invoke('recent_recordings');renderRecordings();}
      finally{setJobBusy(false);progress.remove();}
    };
    const row=node('article',{class:'recording-item'},[node('h2',{text:date}),node('p',{class:'muted',text:`${t(recording.needs_recovery?'Interrupted recording':'Saved')} · ${(recording.bytes/1048576).toFixed(1)}${t(' MB')}${recording.elapsed_ms?t(' · logged {time}',{time:clock(recording.elapsed_ms)}):''}`})]);
    if(recording.warning)row.append(node('p',{text:errorText(recording.warning)}));
    const actions=node('div',{class:'actions'});
    if(recording.recovery_copy)actions.append(button('Open recovered copy',()=>open(recording.recovery_copy),true));
    const mainAction=button(recording.needs_recovery?'Recover copy':'Open',recording.needs_recovery?recover:()=>open(recording.id),!recording.recovery_copy);mainAction.disabled=!recording.source_exists;
    actions.append(mainAction,button('Show folder',()=>invoke('reveal_recording',{id:recording.id})));
    if(recording.needs_recovery && recording.source_exists)actions.append(button('Open original',()=>open(recording.id)));
    if(!recording.source_exists)row.append(node('p',{text:t('Source file is missing. Check the recording folder.')}));
    row.append(actions);list.append(row);
  }
  content.append(list,node('p',{class:'muted',text:t('Recovery leaves the original unchanged and rebuilds the MP4 index in a copy. An incomplete final fragment may be lost.')}));
}
function selected() { return displays.find(d => d.id === selectedDisplay) || displays[0]; }
function fullRegion(d = selected()) { return { x: 0, y: 0, width: d.width & ~1, height: d.height & ~1 }; }
function overlayRegion(){const full=fullRegion();return region && Object.keys(full).some(key=>full[key]!==region[key])?region:null;}
function regionInputs(value, width, height, update) {
  const inputs = [number(value.x, 0, width - 2), number(value.y, 0, height - 2), number(value.width, 2, width, 2), number(value.height, 2, height, 2)];
  const pending = new Set();
  inputs.forEach(input => {
    input.addEventListener('input',()=>pending.add(input));
    input.addEventListener('change', () => {
      if (inputs.some(i => !i.reportValidity())) return;
      pending.delete(input);
      const [x, y, width, height] = inputs.map(i => Number(i.value)); update({ x, y, width, height });
    });
  });
  return { element: node('div', { class: 'region-fields' }, inputs.map((input, i) => field(['X, px', 'Y, px', 'Width', 'Height'][i], input))),
    set(rect) { inputs.forEach((input, i) => {if(!pending.has(input))input.value = [rect.x, rect.y, rect.width, rect.height][i];}); }, inputs };
}

function renderHome() {
  content.replaceChildren(node('div',{class:'page-heading'},node('div',{},[node('h1', { text: t('Record your screen') }),node('p',{class:'muted',text:t('Choose what to capture.')})])));
  const d = selected();
  if (!d) { content.append(node('p', { text: t('No displays found. Connect a display and restart the app.') })); return; }
  region ||= fullRegion(d);
  if (phase !== 'idle' || countdown) {
    content.append(node('p', {class:'muted',text:`${displayLabel(d)} · ${region.width} × ${region.height} · ${settings.fps} FPS`}),
      node('section', {id:'capture-panel','aria-label':'Recording status',class:'panel spaced'}),
      node('p',{class:'kbd-hint',text:t('Stop: {stop} · pause: {pause}',{stop:shortcutLabel(settings.stop_hotkey),pause:shortcutLabel(settings.pause_hotkey)})}));
    updateStatus(lastStatus && lastStatus.phase === phase ? lastStatus : {phase,elapsed_ms:0});
    return;
  }
  const displaySelect = select(displays.map(d => [d.id, `${displayLabel(d)} · ${d.width} × ${d.height}`]), d.id, value => { selectedDisplay = Number(value); region = fullRegion(); renderHome(); });
  displaySelect.disabled = phase !== 'idle';
  const outline=node('div',{class:'capture-outline'});
  const dimensions=node('strong',{class:'capture-dimensions'});
  const selectionLabel=node('span',{class:'muted'});
  const diagram=node('div',{class:'capture-diagram','aria-hidden':'true'},outline);
  const updateArea=()=>{
    Object.assign(diagram.style,{aspectRatio:`${d.width}/${d.height}`,width:`min(100%, ${Math.min(410,165*d.width/d.height)}px)`});
    Object.assign(outline.style,{left:`${region.x/d.width*100}%`,top:`${region.y/d.height*100}%`,width:`${region.width/d.width*100}%`,height:`${region.height/d.height*100}%`});
    dimensions.textContent=`${region.width} × ${region.height}`;
    selectionLabel.textContent=t(region.width===fullRegion(d).width && region.height===fullRegion(d).height && !region.x && !region.y?'Entire display':'Selected area');
  };
  const area = regionInputs(region, d.width, d.height, value => { region = fitRegion(value, d.width, d.height); area.set(region); updateArea(); });
  const capture=node('section',{class:'capture-source'},[
    field('Display',displaySelect),
    node('div',{class:'capture-map'},[diagram,node('div',{class:'capture-caption'},[selectionLabel,dimensions]),node('small',{text:t('Capture area on this display')})]),
    node('div', { class: 'area-actions' }, [button('Select area', () => invoke('select_area', { displayId: d.id, region:overlayRegion() })), button('Entire display', () => { region = fullRegion(); area.set(region); updateArea(); })]),
    node('details',{class:'coordinates'},[node('summary',{text:t('Exact coordinates')}),area.element])
  ]);
  const preferences=node('section',{class:'capture-preferences'},[
    node('h2',{text:t('Recording settings')}),
    node('dl',{class:'capture-specs'},[
      node('div',{},[node('dt',{text:t('Frame rate')}),node('dd',{},[String(settings.fps),node('small',{text:' FPS'})])]),
      node('div',{},[node('dt',{text:t('Bitrate')}),node('dd',{},[String(settings.bitrate_mbps),node('small',{text:t(' Mbps')})])]),
      node('div',{},[node('dt',{text:t('Cursor')}),node('dd',{text:t(settings.show_cursor?'Visible':'Hidden')})])
    ]),button('Change settings',()=>navigate('settings')),
    node('h2',{class:'spaced',text:t('Audio sources')}),
    node('div', { class: 'audio-quick' }, [check('System audio', settings.audio.system, value => quickAudio('system', value)), check('Microphone', settings.audio.microphone, value => quickAudio('microphone', value))]),
    node('p',{class:'muted audio-note',text:t('Adjust each track’s volume after recording.')})
  ]);
  const controls = node('fieldset', { disabled: phase !== 'idle' || !!countdown }, [
    node('div',{class:'capture-layout'},[capture,preferences]),
    node('div', { class: 'capture-start' }, [node('div',{},[node('strong',{text:t('Ready to record')}),node('p',{class:'muted',text:settings.countdown_seconds?t('Recording starts after a {seconds} s countdown.',{seconds:settings.countdown_seconds}):t('Recording starts immediately.')})]),button('Start recording', begin, true)])
  ]);
  const status = node('section', { id: 'capture-panel', 'aria-label': 'Recording status', class: 'panel spaced' });
  content.append(controls, status);
  updateArea();
  updateStatus(lastStatus || { phase: 'idle', elapsed_ms: 0 });
}
async function quickAudio(role, value) {
  const controls=content.querySelectorAll('.audio-quick input');controls.forEach(input=>input.disabled=true);
  try { const next = clone(settings); next.audio[role] = value; await invoke('save_settings', { settings: next }); settings = next; }
  catch(error){message(String(error));if(page==='home')renderHome();}
  finally{controls.forEach(input=>input.disabled=false);}
}
async function begin() {
  if (phase !== 'idle' || countdown || starting || jobBusy) return;
  starting = true;setJobBusy(true);
  try {
    await editor?.flush();editor?.pause();
    const seconds=settings.countdown_seconds;
    if (seconds) {
      countdown=true;showPage('home');
      const proceed=await new Promise(resolve=>{
        const title=node('h2',{text:t('Starting in {seconds}…',{seconds}),role:'status'});
        const finish=value=>{clearInterval(countTimer);countdown=false;cancelCountdown=null;resolve(value);};
        cancelCountdown=()=>finish(false);
        const cancel=button('Cancel',()=>cancelCountdown?.());
        const panel=$('#capture-panel');panel.hidden=false;panel.replaceChildren(title,cancel);cancel.focus();
        const deadline=performance.now()+seconds*1000;
        countTimer=setInterval(()=>{
          const remaining=Math.ceil((deadline-performance.now())/1000);
          if(remaining<=0){finish(true);return;}
          const text=t('Starting in {seconds}…',{seconds:remaining});if(title.textContent!==text)title.textContent=text;
        },100);
      });
      if(!proceed){showPage('home');content.querySelector('.capture-start button')?.focus();return;}
    }
    phase='preparing';showPage('home');
    try { await invoke('start_capture', { displayId:selected().id, region }); }
    catch(e){phase='idle';lastStatus={phase:'idle',elapsed_ms:0};showPage('home');throw e;}
  } finally {starting=false;setJobBusy(false);}
}
function updateStatus(status) {
  lastStatus = status; phase = status.phase;
  if (status.error) message(status.error);
  const panel = $('#capture-panel'); if (!panel || countdown) return;
  if (phase === 'idle') { panel.hidden = true; return; }
  panel.hidden = false;
  const title = { preparing: 'Preparing recording…', recording: 'Recording', paused: 'Paused', saving: 'Saving recording…' }[phase];
  if (panel.dataset.phase !== phase) {
    panel.dataset.phase = phase;
    panel.replaceChildren(node('h2', { text: t(title) }), node('p', { id: 'record-time', class: 'recording-timer', text: clock(status.elapsed_ms) }),
      node('div', { class: 'row' }, [button(phase === 'paused' ? 'Resume' : 'Pause', () => invoke('pause_capture')), button('Stop and save', () => invoke('stop_capture'), true), button('Compact controls', () => invoke('compact_capture'))]),
      node('p', { id: 'record-encoder', class: 'muted' }), node('div', { id: 'record-meters', class: 'stack' }));
    panel.querySelectorAll('button').forEach((b,i) => b.disabled = phase === 'saving' || (phase === 'preparing' && i===0));
    for (const [role, label] of [['system', 'System audio'], ['microphone', 'Microphone']]) if (settings.audio[role]) $('#record-meters').append(node('label', { class: 'meter-row' }, [t(label), node('meter', { id: `${role}-meter`, min: 0, max: 100, value: 0 })]));
  }
  $('#record-time').textContent = clock(status.elapsed_ms);
  $('#record-encoder').textContent = status.encoder ? t('{encoder} · {frames} frames · {dropped} dropped',{encoder:status.encoder,frames:status.frames,dropped:status.dropped_frames}) : t('Waiting for the first frame');
  for (const role of ['system', 'microphone']) if ($(`#${role}-meter`)) $(`#${role}-meter`).value = status[`${role}_level`] ?? 0;
}

function renderSettings() {
  const draft = clone(settings);
  const form = node('form', { class: 'settings-form' });
  form.addEventListener('submit', e => { e.preventDefault(); safely(async () => { if (!form.reportValidity()) return; const submit=form.querySelector('[type=submit]');submit.disabled=true;try{await invoke('save_settings', { settings: draft }); const previous=locale();settings = draft; applyLanguage();theme(); shortcutHint();if(previous!==locale()){renderSettings();content.querySelector('[type=submit]').focus();}message('Settings saved', true);}finally{submit.disabled=false;} }); });
  function valueField(label, key, input) { input.addEventListener('change', () => draft[key] = input.type === 'number' ? Number(input.value) : input.value); return field(label, input); }
  const basics = node('fieldset', {}, [node('legend', { text: t('Video') }),
    field('Frame rate', select([15, 24, 30, 60].map(n => [n, `${n} FPS`]), draft.fps, value => draft.fps = Number(value))),
    valueField('Bitrate, Mbps', 'bitrate_mbps', number(draft.bitrate_mbps, 1, 100)),
    valueField('Countdown, seconds', 'countdown_seconds', number(draft.countdown_seconds, 0, 10)),
    check('Show cursor in recording', draft.show_cursor, v => draft.show_cursor = v),
    node('p', { class: 'muted', text: t('Higher frame rates and bitrates improve motion detail and increase file size.') })]);
  const audio = node('fieldset', {}, [node('legend', { text: t('Audio') })]);
  for (const [role, label, options] of [['system', 'System audio', systemDevices], ['microphone', 'Microphone', micDevices]]) {
    audio.append(check(label, draft.audio[role], value => draft.audio[role] = value), field('Device', select(options.map(d => [d.id, d.id?d.name:t('Default device')]), draft.audio[`${role}_device`] || '', value => draft.audio[`${role}_device`] = value || null)));
  }
  const keys = node('fieldset', {}, [node('legend', { text: t('Keyboard shortcuts') })]);
  const mac=/Mac/.test(navigator.platform);
  for (const [key,label,fallback] of shortcutActions) {
    const picker=button(shortcutLabel(draft[key],mac),()=>recordShortcut({label,value:draft[key],invoke,subscribe:listen,onAccept:value=>{
      const conflict=shortcutConflict(draft,key,value);if(conflict)throw Error(t('Shortcut already used by: {action}',{action:t(conflict)}));
      draft[key]=value;picker.textContent=shortcutLabel(value,mac);
    }}));
    picker.classList.add('shortcut-picker');picker.title=t('Click and press your shortcut');
    const reset=button('Reset',()=>{const conflict=shortcutConflict(draft,key,fallback);if(conflict)throw Error(t('Default shortcut already used by: {action}',{action:t(conflict)}));draft[key]=fallback;picker.textContent=shortcutLabel(fallback,mac);});reset.setAttribute('aria-label',t('Reset: {action}',{action:t(label)}));
    keys.append(node('div',{class:'shortcut-row'},[field(label,picker),reset]));
  }
  keys.append(node('small', { text: t('Click a shortcut and press your keys, then save settings. Shortcuts used by another app cannot be assigned.') }));
  const app = node('fieldset', { class: 'stack' }, [node('legend', { text: t('Application') }),
    field('Theme', select([['System', t('System')], ['Light', t('Light')], ['Dark', t('Dark')]], draft.appearance, v => draft.appearance = v)),
    field('Language', select([['System',t('Automatic (system)')],['Russian','Русский'],['English','English']], draft.language || 'System', v => draft.language = v)),
    node('p',{class:'muted',text:t('System language: {language}. English is used when a translation is unavailable.',{language:systemLanguage})}),
    check('Open editor after recording', draft.open_editor, v => draft.open_editor = v),
    check('Start minimized to tray', draft.start_in_tray, v => draft.start_in_tray = v),
    check('Launch at login', draft.autostart, v => draft.autostart = v),
    node('p', { class: 'path', id: 'output-path', text: draft.output_dir }),
    button('Recording folder', async () => { const value = await invoke('choose_folder'); if (value) { draft.output_dir = value; $('#output-path').textContent = value; } })]);
  for(const section of [basics,audio,keys,app])section.classList.add('settings-section');
  form.append(node('div',{class:'page-heading'},node('div',{},[node('h1', { text: t('Settings') }),node('p',{class:'muted',text:t('Video, audio and keyboard shortcuts.')})])), node('div', { class: 'grid' }, [node('div', {}, [basics, audio]), node('div', {}, [keys, app])]), node('div',{class:'settings-save'},node('button', { type: 'submit', class: 'primary', text: t('Save settings') })));
  form.querySelectorAll('button:not([type])').forEach(b => b.type = 'button');
  content.replaceChildren(form);
}

class Editor {
  constructor(document) {
    this.document = document; this.project = clone(document.project); this.undo = []; this.redo = []; this.audios = []; this.playing = false; this.busy = false;
    this.revision=0;this.savedRevision=0;this.pendingSaves=0;
  }
  pause() { this.playbackToken=(this.playbackToken||0)+1;this.playPending=false;this.previewRange=null;this.video?.pause(); this.audios.forEach(a => a.element.pause()); this.context?.suspend().catch(()=>{});this.playing = false; cancelAnimationFrame(this.animation); if (this.playButton) {this.playButton.textContent = t('Play');this.playButton.disabled=!!this.busy;} }
  destroy() { this.cropEditor?.close();this.pause(); this.context?.close();this.timeline?.destroy();clearTimeout(this.saveTimer); }
  editCrop() {
    if(this.busy || this.cropEditor)return;
    this.pause();const {width,height}=this.document.info;
    this.cropEditor=new CropEditor({video:this.video,width,height,crop:this.project.crop,onApply:crop=>this.commit(project=>project.crop=crop),onClose:()=>{this.cropEditor=null;}});
  }
  changed(){this.revision++;this.saveError=null;this.renderSaveStatus();clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.persist().catch(()=>{}),250);}
  renderSaveStatus(){
    if(!this.saveStatus)return;
    const saving=this.pendingSaves>0 || this.savedRevision<this.revision;
    this.saveStatus.textContent=this.saveError?t('Edits not saved: {error}',{error:errorText(this.saveError.message)}):t(saving?'Saving edits…':this.hasSaved?'Edits saved':'Edits save automatically');
    this.saveStatus.classList.toggle('save-error',!!this.saveError);
    if(!this.saveError && document.activeElement===this.retrySave)this.saveStatus.focus();
    this.retrySave.hidden=!this.saveError;this.retrySave.disabled=this.pendingSaves>0 || this.busy;
  }
  persist(){
    const revision=this.revision,project=clone(this.project),documentId=this.document.document_id;
    this.pendingSaves++;this.saveError=null;this.renderSaveStatus();
    this.pendingSave=(this.pendingSave||Promise.resolve()).catch(()=>{}).then(()=>invoke('save_project',{documentId,project})).then(()=>{
      this.savedRevision=Math.max(this.savedRevision,revision);this.hasSaved=true;
      if(this.saveError?.revision<=revision)this.saveError=null;
    }).catch(error=>{if(revision===this.revision)this.saveError={revision,message:error instanceof Error?error.message:String(error)};throw error;}).finally(()=>{this.pendingSaves--;this.renderSaveStatus();});
    return this.pendingSave;
  }
  async flush(){clearTimeout(this.saveTimer);if(this.savedRevision<this.revision)await this.persist();else await this.pendingSave;}
  commit(change) {
    if (this.busy) return;
    const next = clone(this.project); change(next);
    if(JSON.stringify(next)===JSON.stringify(this.project))return;
    this.pause(); this.undo.push(clone(this.project)); if (this.undo.length > 100) this.undo.shift(); this.redo = []; this.project = next; this.timeline?.select(null);this.refresh();
    this.changed();
  }
  changeHistory(redo) {
    const from = redo ? this.redo : this.undo, to = redo ? this.undo : this.redo;
    if (!from.length || this.busy) return;
    this.pause(); to.push(clone(this.project)); this.project = from.pop(); this.timeline?.select(null);this.refresh();
    this.changed();
  }
  mount() {
    this.destroy(); this.context = null; this.audios = [];
    const doc = this.document;
    this.video = node('video', { preload: 'metadata', playsInline: true, crossOrigin: 'anonymous', src: convertFileSrc(doc.source), 'aria-label': 'Video preview' });
    this.video.addEventListener('error', () => message('The system player could not open this video. MP4 export is still available. Check the source format and your system H.264 decoder.'));
    this.video.addEventListener('loadedmetadata', () => this.seek(0));
    this.video.addEventListener('seeked', () => { this.syncAudio(true); this.updateTime(); });
    this.video.addEventListener('ended', () => {if(this.video.ended && !this.finishPreview())this.pause();});
    this.video.addEventListener('waiting', () => { this.audios.filter(a=>a.element!==this.video).forEach(a => a.element.pause()); });
    this.video.addEventListener('playing', () => this.syncAudio(true));
    this.video.addEventListener('timeupdate', () => { this.enforceRanges(); this.updateTime(); });
    for (const track of doc.info.audio) {
      if (track.id.startsWith('embedded:') && track.stream !== 0) continue;
      const element = track.id.startsWith('embedded:') ? this.video : node('audio', { preload: 'metadata', crossOrigin: 'anonymous', src: convertFileSrc(track.path) });
      this.audios.push({ id: track.id, element });
    }
    if (!doc.info.audio.some(a => a.id === 'embedded:0')) this.video.muted = true;
    this.playbackRate ||= 1;
    this.speedControl=select([.5,1,1.5,2].map(rate=>[rate,`${rate}×`]),this.playbackRate,value=>{
      this.playbackRate=Number(value);this.video.playbackRate=this.playbackRate;
      this.audios.forEach(track=>track.element.playbackRate=this.playbackRate);
    });
    this.speedControl.title=t('Preview only. Export keeps the original speed.');
    this.video.playbackRate=this.playbackRate;this.audios.forEach(track=>track.element.playbackRate=this.playbackRate);
    const speed=field('Preview speed',this.speedControl);speed.classList.add('preview-speed');
    this.viewport = node('div', { class: 'player-viewport' }, this.video);
    this.viewport.addEventListener('dblclick',()=>this.editCrop());
    this.viewport.title=t('Double-click to crop');
    this.playButton = button('Play', () => this.toggle());
    this.seekbar = node('input', { type: 'range', min: 0, max: duration(this.project), step: 1_000_000 / doc.info.fps, value: 0, 'aria-label': 'Position in edited video', oninput: e => { this.pause(); this.seek(Number(e.target.value)); } });
    this.time = node('time');
    this.timeline = new Timeline({fps:doc.info.fps,source:convertFileSrc(doc.source),onPause:()=>this.pause(),onSeek:at=>this.seek(at),onError:error=>message(error),onPreview:range=>safely(async()=>{this.pause();this.seek(range.start);await this.toggle(range);}),onExport:range=>safely(()=>this.export(range)),
      onEdit:(start,end,retain)=>{this.commit(p=>p.keep=editTimeline(p.keep,start,end,retain));this.seek(retain?0:Math.min(start,Math.max(0,duration(this.project)-1e6/doc.info.fps)));},
      onSplit:at=>this.commit(p=>p.keep=splitTimeline(p.keep,snapTime(at,doc.info.fps,duration(p))))});
    this.controls = node('fieldset', { class: 'editor-controls' });
    this.cropInfo=node('p',{class:'muted'});
    this.resetCrop=button('Reset crop',()=>this.commit(project=>project.crop=null));
    this.undoButton = button('Undo', () => this.changeHistory(false)); this.redoButton = button('Redo', () => this.changeHistory(true));
    this.audioControls = node('div');
    this.controls.append(
      node('h2',{class:'inspector-title',text:t('Edit')}),
      node('div', { class: 'history-actions' }, [this.undoButton, this.redoButton]),
      node('div',{class:'export-actions'},button('Save project', () => this.save())),
      toolSection('Editing shortcuts',[
        node('dl',{class:'shortcut-help'},[['Space','Play / pause'],['S','Split at playhead'],['I / O','Selection start / end'],['Delete','Delete selection'],['Esc','Clear selection'],['← / →','Previous / next frame'],['Shift + ← / →','Move 10 frames'],['Home / End','Video start / end'],['Ctrl / ⌘ + S','Save project'],['Ctrl / ⌘ + Shift + S','Export MP4'],['Ctrl / ⌘ + Z','Undo'],['Ctrl / ⌘ + Shift + Z','Redo']].map(([key,description])=>node('div',{},[node('dt',{text:key}),node('dd',{text:t(description)})]))) ]),
      toolSection('Crop',[this.cropInfo,node('div',{class:'row'},[button('Crop video',()=>this.editCrop()),this.resetCrop])]),
      toolSection('Audio',this.audioControls)
    );
    this.exportState = node('div', { class: 'export-state', 'aria-live': 'polite' });
    const preview=node('section',{class:'editor-preview','aria-label':'Video and timeline'},[
      node('div', { class: 'player-shell' }, this.viewport),
      node('div', { class: 'transport' }, [this.playButton, this.seekbar, this.time]),
      node('div',{class:'frame-controls'},[button('Previous frame',()=>this.step(-1)),button('Next frame',()=>this.step(1)),button('Previous cut',()=>this.timeline.jumpCut(-1)),button('Next cut',()=>this.timeline.jumpCut(1)),speed,node('span', { class: 'muted', id: 'source-position' })]),
      node('p', { class: 'kbd-hint', text: t('Space: play. Arrows: step by frame. Your source video stays unchanged.') })
    ]);
    this.saveStatus=node('p',{class:'save-status muted',role:'status',tabIndex:-1});
    this.retrySave=button('Retry save',async()=>{await this.persist();message();});this.retrySave.hidden=true;
    this.exportButton=button('Export MP4', () => this.export(), true);
    content.replaceChildren(node('div', { class: 'page-heading' }, [node('div',{},[node('h1', { text: doc.source.split(/[\\/]/).at(-1) }),node('p',{class:'muted',text:`${doc.info.width} × ${doc.info.height} · ${doc.info.fps} FPS`}),node('div',{class:'save-feedback'},[this.saveStatus,this.retrySave])]),node('div',{class:'editor-heading-actions'},[button('Show folder', () => invoke('reveal_project')),this.exportButton])]),
      node('div',{class:'editor-workspace'},[preview,this.timeline.element,node('aside',{class:'editor-inspector','aria-label':'Editing tools'},[this.controls,this.exportState])]));
    for(const warning of doc.warnings||[])content.append(node('p',{class:'notice',text:errorText(warning)}));
    this.refresh();
    this.renderSaveStatus();
  }
  refresh() {
    const { width, height } = this.document.info, crop = this.project.crop || { x: 0, y: 0, width, height };
    this.viewport.style.aspectRatio = `${crop.width}/${crop.height}`;
    this.viewport.style.width = `min(100%, calc(var(--preview-height, 300px) * ${crop.width/crop.height}))`;
    Object.assign(this.video.style, { width: `${width / crop.width * 100}%`, left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%` });
    this.cropInfo.textContent=this.project.crop?t('Output: {width} × {height} px',crop):t('Full frame: {width} × {height} px',{width,height});
    this.resetCrop.disabled=!this.project.crop;
    this.seekbar.max = Math.max(0, duration(this.project) - 1_000_000 / this.document.info.fps);
    this.undoButton.disabled = !this.undo.length; this.redoButton.disabled = !this.redo.length;
    this.timeline.update(this.project);
    this.audioControls.replaceChildren(check('Mute all audio', this.project.muted, value => this.commit(p => p.muted = value)));
    for (const [index, track] of this.project.audio.entries()) {
      const label = audioLabel(this.document.info.audio.find(a => a.id === track.track_id));
      const output = node('output', { text: t('{value} dB',{value:`${track.gain_db > 0 ? '+' : ''}${track.gain_db}`}) });
      const slider = node('input', { type: 'range', min: -60, max: 20, step: 1, value: track.gain_db, 'aria-label': t('Volume: {track}',{track:t(label)}) });
      let original;
      slider.addEventListener('input', () => { original ||= clone(this.project); this.project.audio[index].gain_db = Number(slider.value); output.textContent = t('{value} dB',{value:slider.value}); this.applyMix(); });
      slider.addEventListener('change', () => { if (original) { this.undo.push(original); this.redo = []; original = null; this.undoButton.disabled = false;this.changed(); } });
      this.audioControls.append(node('div', { class: 'audio-track' }, [check(label, !track.muted, value => this.commit(p => p.audio[index].muted = !value)), slider, output]));
    }
    if (this.document.info.audio.some(a => a.id.startsWith('embedded:') && a.stream > 0)) this.audioControls.append(node('p', { class: 'muted', text: t('This video has multiple embedded audio streams. Preview plays the first; export mixes all enabled tracks.') }));
    this.enforceRanges(); this.applyMix(); this.updateTime();
  }
  seek(at) {
    if(this.busy)return;
    const last=Math.max(0,duration(this.project)-1e6/this.document.info.fps);
    this.video.currentTime=sourceTime(this.project,Math.max(0,Math.min(at,last)))/1e6;
    this.syncAudio(true);this.updateTime();
  }
  step(amount) { this.pause(); this.seek(Math.max(0, Math.min(duration(this.project) - 1e6 / this.document.info.fps, editedTime(this.project, this.video.currentTime * 1e6) + amount * 1e6 / this.document.info.fps))); }
  finishPreview() {
    if(!this.playing || !this.previewRange)return false;
    const range=this.previewRange;
    if(this.timeline.loopPreview){
      this.seek(range.start);
      if(this.video.paused){
        const token=this.playbackToken;
        this.video.play().catch(error=>{if(token===this.playbackToken){this.pause();message(t('Cannot repeat preview: {error}',{error:errorText(error)}));}});
      }
    }else{
      this.pause();this.seek(Math.max(range.start,range.end-1e6/this.document.info.fps));
    }
    return true;
  }
  enforceRanges() {
    if (!Number.isFinite(this.video.currentTime)) return;
    const at = this.video.currentTime * 1e6;
    if(this.playing && this.previewRange && editedTime(this.project,at)>=this.previewRange.end-0.5){
      this.finishPreview();return;
    }
    if (this.project.keep.some(r => at >= r.start_us - 0.5 && at < r.end_us - 0.5)) return;
    const next = this.project.keep.find(r => r.start_us > at);
    if (next) this.video.currentTime = next.start_us / 1e6;
    else { this.pause(); this.video.currentTime = Math.max(this.project.keep.at(-1).start_us, this.project.keep.at(-1).end_us - 1e6 / this.document.info.fps) / 1e6; }
    this.syncAudio(true);
  }
  updateTime() {
    const at = editedTime(this.project, (this.video.currentTime || 0) * 1e6);
    this.seekbar.value = at; this.time.textContent = t('{position} / {duration} s',{position:seconds(at),duration:seconds(duration(this.project))});
    this.timeline.position(at,{follow:this.playing});
    const source = $('#source-position'); if (source) source.textContent = t('Source: {time} s',{time:seconds((this.video.currentTime || 0) * 1e6)});
  }
  async sound() {
    if (!this.context) {
      this.context = new AudioContext();
      this.limiter = this.context.createDynamicsCompressor(); this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.connect(this.context.destination);
      for (const track of this.audios) { track.source = this.context.createMediaElementSource(track.element); track.gain = this.context.createGain(); track.source.connect(track.gain).connect(this.limiter); }
    }
    await this.context.resume(); this.applyMix();
  }
  applyMix() {
    for (const track of this.audios) {
      const mix = this.project.audio.find(a => a.track_id === track.id);
      if (track.gain) track.gain.gain.value = this.project.muted || mix?.muted ? 0 : 10 ** ((mix?.gain_db || 0) / 20);
    }
  }
  syncAudio(force = false) {
    for (const track of this.audios) {
      if (track.element === this.video) continue;
      if (force || Math.abs(track.element.currentTime - this.video.currentTime) > 0.06) track.element.currentTime = this.video.currentTime;
      if (this.playing && this.video.readyState >= 3 && this.video.currentTime < (track.element.duration || Infinity)) track.element.play().catch(e => message(t('Cannot play audio track: {error}',{error:errorText(e)})));
      else track.element.pause();
    }
  }
  async toggle(range=null) {
    if (this.playing) { this.pause(); return; }
    if (this.playPending || this.busy) return;
    const token=this.playbackToken=(this.playbackToken||0)+1;
    this.playPending=true;this.playButton.disabled=true;
    this.previewRange=range;
    if (!range && this.video.currentTime * 1e6 >= this.project.keep.at(-1).end_us - 1e6 / this.document.info.fps - 0.5) this.seek(0);
    try {
      await this.sound();
      if(token!==this.playbackToken)return;
      this.enforceRanges();this.playing=true;
      await this.video.play();
      if(token!==this.playbackToken)return;
    }catch(error){if(token===this.playbackToken){this.pause();throw error;}return;}
    finally{if(token===this.playbackToken){this.playPending=false;this.playButton.disabled=!!this.busy;}}
    this.syncAudio(true); this.playButton.textContent = t('Pause');
    const frame = () => { if (!this.playing) return; this.enforceRanges(); this.updateTime(); this.syncAudio(); this.animation = requestAnimationFrame(frame); }; frame();
  }
  async save() { await this.flush();if(!this.revision)await this.persist();message('Project saved beside the source video', true); }
  revealExport() {
    const inspector=this.exportState.closest('.editor-inspector');
    if(getComputedStyle(inspector).overflowY==='auto')inspector.scrollTop=inspector.scrollHeight;
    else this.exportState.scrollIntoView({block:'nearest'});
  }
  async export(range=null) {
    if(this.busy)return;
    const project=clone(this.project);
    if(range)project.keep=editTimeline(project.keep,range.start,range.end,true);
    const crop=project.crop||this.document.info;
    const summary=t('{range} · {duration} s · {width} × {height}',{range:t(range?'Selected range':'Entire edit'),duration:seconds(duration(project)),width:crop.width,height:crop.height});
    this.pause();this.busy = true; this.controls.disabled = true; this.exportButton.disabled=true;this.playButton.disabled = true;this.speedControl.disabled=true;this.timeline.setBusy(true);setJobBusy(true);this.renderSaveStatus();
    this.progress = node('progress', { value: 0, max: 1, 'aria-label': 'Export progress' });
    const progressText=node('p',{text:t('Exporting MP4…')});
    this.exportState.replaceChildren(progressText,node('p',{class:'muted',text:summary}),this.progress,button('Cancel export',async()=>{await invoke('cancel_export');progressText.textContent=t('Cancelling export…');}));
    this.revealExport();
    try {
      try{await this.flush();}catch(error){message(t('Could not save the project beside the source: {error}. Export uses your current edits.',{error:errorText(error)}));}
      const path = await invoke('export_video', { documentId:this.document.document_id,project,selection:!!range });
      if(path)this.exportState.replaceChildren(node('h3',{text:t(range?'Selection exported':'Video exported')}),node('p',{class:'muted',text:summary}),node('p',{class:'export-path',text:path}),node('div',{class:'row'},[button('Open video',()=>invoke('open_export',{folder:false})),button('Open folder',()=>invoke('open_export',{folder:true}))]));
      else this.exportState.replaceChildren(node('p',{text:t('Export cancelled')}));
      this.revealExport();
    }
    catch(error){this.exportState.replaceChildren(node('p',{text:t('Could not export MP4. Try exporting again.')}));throw error;}
    finally { this.progress=null;this.busy = false; this.controls.disabled = false; this.exportButton.disabled=false;this.playButton.disabled = false;this.speedControl.disabled=false;this.timeline.setBusy(false);setJobBusy(false);this.renderSaveStatus(); }
  }
}

async function openVideo(last = false) {
  requireIdle();
  await editor?.flush();editor?.pause(); message('Opening video…', true);
  setJobBusy(true);
  try {
    const document = await invoke('open_video', { last });
    if (document) acceptDocument(document);
    message();
  } finally { setJobBusy(false); }
}

async function overlay() {
  document.documentElement.classList.add('overlay');
  const query = new URLSearchParams(location.search), width = Number(query.get('width')), height = Number(query.get('height')), displayId = Number(query.get('display'));
  let rect = { x: Number(query.get('x')), y: Number(query.get('y')), width: Number(query.get('w')), height: Number(query.get('h')) };
  let exists = rect.width >= 2 && rect.height >= 2, drag, pending=false;
  const stage = node('div', { class: 'selection-stage' });
  const shade = node('div', { class: 'selection-shade' });
  const box = node('div', { class: 'selection-box' }, ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(handle => node('span', { class: 'handle', 'data-handle': handle })));
  box.tabIndex=0;box.setAttribute('role','group');box.setAttribute('aria-label',t('Capture area. Arrow keys move it. Alt and arrow keys resize it.'));
  const inputs = regionInputs(rect, width, height, value => { rect = fitRegion(value, width, height); exists = true; draw(); });
  const feedback=node('p',{class:'selection-feedback',role:'alert',hidden:true});
  const dimensions=node('output',{class:'selection-dimensions'});
  const perform=async(action)=>{
    if(pending)return;pending=true;feedback.hidden=true;
    toolbar.querySelectorAll('button,input').forEach(control=>control.disabled=true);
    try{await action();}catch(error){feedback.textContent=errorText(error);feedback.hidden=false;}
    finally{pending=false;toolbar.querySelectorAll('button,input').forEach(control=>control.disabled=false);draw();}
  };
  const confirm=(startRecording=true)=>{
    if(exists && !inputs.inputs.some(input=>!input.reportValidity()))return perform(()=>invoke('apply_region',{displayId,region:rect,startRecording}));
  };
  const cancel=()=>perform(()=>invoke('cancel_selection'));
  const toolbar = node('div', { class: 'selection-toolbar' }, [dimensions,node('div', { class: 'row' }, [button('Record area',()=>confirm(),true),button('Use area',()=>confirm(false)),button('Cancel',cancel)]),node('details',{},[node('summary',{text:t('Exact coordinates')}),inputs.element]),node('small', { text: t('Enter: record · Esc: cancel · arrows: move · Alt+arrows: resize') }),feedback]);
  toolbar.querySelector('details').addEventListener('toggle',draw);
  stage.append(shade, box, node('div', { class: 'selection-help', text: t('Drag to select an area. Move it or resize it using the handles.') }), toolbar); document.body.append(stage);
  const point = e => ({ x: Math.round(e.clientX * width / innerWidth), y: Math.round(e.clientY * height / innerHeight) });
  function draw() {
    box.hidden=!exists;toolbar.hidden=!exists && feedback.hidden;shade.hidden=exists;
    if (!exists) {Object.assign(toolbar.style,{left:'12px',top:'100px'});return;}
    dimensions.textContent=`${rect.width} × ${rect.height}`;
    const sx = innerWidth / width, sy = innerHeight / height;
    Object.assign(box.style, { left: `${rect.x * sx}px`, top: `${rect.y * sy}px`, width: `${rect.width * sx}px`, height: `${rect.height * sy}px` });
    inputs.set(rect);
    Object.assign(toolbar.style, { left: `${Math.max(12, Math.min(innerWidth - toolbar.offsetWidth - 12, rect.x * sx))}px`, top: `${Math.max(12, Math.min(innerHeight - toolbar.offsetHeight - 12, (rect.y + rect.height) * sy + 12))}px` });
  }
  stage.addEventListener('pointerdown', e => {
    if (pending || toolbar.contains(e.target) || e.button!==0 || drag) return;
    const start = point(e), handle = e.target.dataset.handle || (box.contains(e.target) ? 'move' : 'new');
    drag = { start, handle, original: { ...rect }, existed:exists, pointerId:e.pointerId }; stage.setPointerCapture(e.pointerId);
    if (handle === 'new') { rect = { ...start, width: 2, height: 2 }; exists = true; draw(); }
  });
  stage.addEventListener('pointermove', e => {
    if (!drag || e.pointerId!==drag.pointerId) return;
    const at = point(e), dx = at.x - drag.start.x, dy = at.y - drag.start.y;
    rect = drag.handle === 'new' ? fitRegion({ x: Math.min(drag.start.x, at.x), y: Math.min(drag.start.y, at.y), width: Math.max(2, Math.abs(dx)), height: Math.max(2, Math.abs(dy)) }, width, height) : dragRegion(drag.original, drag.handle, dx, dy, width, height); draw();
  });
  stage.addEventListener('pointerup',e=>{if(drag && e.pointerId===drag.pointerId){drag=null;box.focus({preventScroll:true});}});
  const cancelDrag=()=>{if(drag){rect=drag.original;exists=drag.existed;drag=null;draw();}};
  stage.addEventListener('pointercancel',cancelDrag);stage.addEventListener('lostpointercapture',cancelDrag);
  window.addEventListener('keydown', e => {
    if(pending)return;
    if (e.key === 'Escape') { e.preventDefault();cancelDrag();cancel();return; }
    if (e.key === 'Enter' && !e.target.closest('button,summary')) { e.preventDefault();if(!e.repeat && !drag)confirm();return; }
    if (!exists || e.target instanceof HTMLInputElement || !e.key.startsWith('Arrow')) return;
    e.preventDefault(); const delta = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -delta : e.key === 'ArrowRight' ? delta : 0;
    const dy = e.key === 'ArrowUp' ? -delta : e.key === 'ArrowDown' ? delta : 0;
    rect = dragRegion(rect, e.altKey ? `${dx ? 'e' : ''}${dy ? 's' : ''}` : 'move', dx, dy, width, height); draw();
  });
  addEventListener('resize', draw); draw();
}

async function main() {
  if (new URLSearchParams(location.search).has('overlay')) { await overlay(); return; }
  setJobBusy(true);
  $('#home-nav').onclick = () => safely(async () => { if (jobBusy || editor?.busy || countdown || starting) throw Error(t('Wait for the current operation to finish')); await editor?.flush(); showPage('home'); });
  $('#settings-nav').onclick = () => safely(() => navigate('settings'));
  $('#recordings-nav').onclick = () => safely(refreshRecordings);
  $('#open-nav').onclick = () => safely(() => openVideo());
  $('#quit').onclick = () => safely(async () => { await editor?.flush(); await invoke('quit'); });
  await listen('capture-status', e => updateStatus(e.payload));
  await listen('recording-finished', e => safely(async () => { phase = 'idle';lastStatus={phase:'idle',elapsed_ms:0}; if (e.payload.error) {message(e.payload.error);showPage('home');} else if (e.payload.open_editor) await openVideo(true); else { message('Recording saved', true); showPage('home'); } }));
  await listen('region-selected', e => safely(async()=>{requireIdle();region=e.payload.region;selectedDisplay=e.payload.display_id;showPage('home');if(e.payload.start_recording)await begin();}));
  await listen('new-recording', () => safely(async () => { requireIdle(); await editor?.flush(); showPage('home'); await invoke('select_area', { displayId: selected().id, region:overlayRegion() }); }));
  await listen('navigate', e => safely(() => navigate(e.payload)));
  await listen('open-last', () => safely(() => openVideo(true)));
  await listen('external-open-request', () => safely(openPending));
  await listen('quit-request', () => safely(async () => { await editor?.flush(); await invoke('quit'); }));
  await listen('export-progress', e => { if (editor?.progress) editor.progress.value = e.payload; });
  await listen('ui-error', e => message(e.payload));
  const data = await invoke('bootstrap'); settings = data.settings; displays = data.displays; selectedDisplay = displays[0]?.id; systemDevices = data.system_devices; micDevices = data.microphone_devices; recordings = data.recordings;
  systemLanguage=data.system_language || systemLanguage;applyLanguage();theme();shortcutHint();$('#app-version').textContent=data.version?`v${data.version}`:'';setJobBusy(false);
  if (data.error) message(data.error);
  if(data.document)acceptDocument(data.document);
  else if(recordings.some(r=>r.needs_recovery && !r.recovery_copy))showPage('recordings');
  else showPage('home');
  updateStatus(await invoke('capture_status'));
  if(data.pending_open)await openPending();
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && countdown) { e.preventDefault();cancelCountdown?.();return; }
    if (page !== 'editor' || editor.busy) return;
    if(document.querySelector('dialog[open]'))return;
    if(e.key==='Escape'){e.preventDefault();editor.timeline.cancelDrag();editor.timeline.select(null);return;}
    const command=e.ctrlKey || e.metaKey,code=keyboardCode(e);
    if(command && code==='KeyS'){e.preventDefault();safely(()=>e.shiftKey?editor.export():editor.save());return;}
    if(command && ['KeyZ','KeyY'].includes(code) && !e.target.closest('input,textarea,[contenteditable=true]')){e.preventDefault();editor.changeHistory(code==='KeyY' || e.shiftKey);return;}
    if(e.target.closest('input,select,button:not(.timeline-clip),textarea,summary,a,[contenteditable=true]'))return;
    if(command && code==='KeyA'){e.preventDefault();editor.pause();editor.timeline.select({start:0,end:duration(editor.project)});return;}
    if(!command && !e.altKey && ['KeyI','KeyO'].includes(code)){e.preventDefault();editor.timeline.mark(code==='KeyI'?'start':'end');return;}
    if(['Home','End'].includes(e.key)){e.preventDefault();editor.pause();editor.seek(e.key==='Home'?0:duration(editor.project));return;}
    if(e.key==='Delete' || e.key==='Backspace'){e.preventDefault();safely(()=>editor.timeline.edit(false));}
    if(!e.ctrlKey && !e.metaKey && !e.altKey && code==='KeyS'){e.preventDefault();safely(()=>editor.timeline.onSplit(editor.timeline.at));}
    if (code === 'Space') { e.preventDefault(); safely(() => editor.toggle()); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault();const direction=e.key==='ArrowLeft'?-1:1; if(command)editor.timeline.jumpCut(direction);else editor.step(direction*(e.shiftKey?10:1)); }
  });
}
main().catch(error=>{
  message(String(error));
  if(document.documentElement.classList.contains('overlay'))return;
  setJobBusy(true);
  content.replaceChildren(node('section',{class:'empty-state'},[node('h1',{text:t('Could not start Screen Recorder')}),node('p',{class:'muted',text:t('Check the error above, then try again.')}),button('Retry',()=>location.reload(),true)]));
});
