const aliases = {ctrl:'Control',control:'Control',shift:'Shift',alt:'Alt',option:'Alt',meta:'Super',super:'Super',cmd:'Super',command:'Super'};
const order = ['Control','Alt','Shift','Super'];
export const shortcutActions = [['hotkey','Select area','Control+Shift+F9'],['stop_hotkey','Stop recording','Control+Shift+F10'],['pause_hotkey','Pause / resume','Control+Shift+F11']];

export function keyboardCode(event) {
  if(event.code && event.code!=='Unidentified')return event.code;
  const key=event.keyCode;
  if(key>=65 && key<=90)return `Key${String.fromCharCode(key)}`;
  if(key>=48 && key<=57)return `Digit${key-48}`;
  if(key>=96 && key<=105)return `Numpad${key-96}`;
  if(key>=112 && key<=135)return `F${key-111}`;
  return ({8:'Backspace',16:'Shift',17:'Control',18:'Alt',19:'Pause',32:'Space',33:'PageUp',34:'PageDown',35:'End',36:'Home',37:'ArrowLeft',38:'ArrowUp',39:'ArrowRight',40:'ArrowDown',44:'PrintScreen',45:'Insert',46:'Delete',91:'Meta',92:'Meta'})[key]||event.key||'';
}

export function normalizeShortcut(value) {
  const parts=value.split('+'),key=parts.pop();
  const mods=parts.map(part=>aliases[part.toLowerCase()]);
  const code=/^[a-z]$/i.test(key)?`Key${key.toUpperCase()}`:/^\d$/.test(key)?`Digit${key}`:key;
  return [...order.filter(mod=>mods.includes(mod)),code.toUpperCase()].join('+');
}
export function shortcutLabel(value,mac=false) {
  const names={Control:'Ctrl',Super:mac?'⌘ Cmd':'Win',Alt:mac?'Option':'Alt',PRINTSCREEN:'Print Screen',SPACE:'Space',ARROWLEFT:'←',ARROWRIGHT:'→',ARROWUP:'↑',ARROWDOWN:'↓'};
  return normalizeShortcut(value).split('+').map(key=>names[key]||key.replace(/^KEY|^DIGIT/,'')).join(' + ');
}
export function shortcutFromEvent(event) {
  const code=keyboardCode(event);
  if(event.repeat || event.isComposing || /^(Control|Shift|Alt|Meta)/.test(code))return null;
  if(event.getModifierState?.('AltGraph'))throw Error('Use Ctrl or Alt instead of AltGr');
  if(!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|PrintScreen|Pause|Space|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Numpad[0-9])$/.test(code))throw Error('Choose a letter, number, function key or Print Screen');
  if(!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d+$|^PrintScreen$|^Pause$/.test(code))throw Error('Add Ctrl, Alt or Command to avoid interfering with typing');
  return [...(event.ctrlKey?['Control']:[]),...(event.altKey?['Alt']:[]),...(event.shiftKey?['Shift']:[]),...(event.metaKey?['Super']:[]),code].join('+');
}
export function shortcutConflict(draft,key,value) {
  return shortcutActions.find(([other])=>other!==key && normalizeShortcut(draft[other])===normalizeShortcut(value))?.[1];
}

export async function recordShortcut({label,value,onAccept,invoke,subscribe}) {
  const dialog=document.createElement('dialog');dialog.className='shortcut-dialog';
  const heading=document.createElement('h2');heading.textContent=label;heading.id='shortcut-title';dialog.setAttribute('aria-labelledby',heading.id);
  const hint=document.createElement('p');hint.textContent='Press your new shortcut. Esc cancels.';
  const output=document.createElement('output');output.className='shortcut-preview';output.textContent='Preparing shortcut input…';output.setAttribute('aria-live','polite');
  const error=document.createElement('p');error.className='shortcut-error';error.setAttribute('role','status');
  const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.type='button';
  dialog.append(heading,hint,output,error,cancel);document.body.append(dialog);dialog.showModal();cancel.focus();
  let active=true,ready=false,unlisten,timer;
  const close=()=>{
    if(!active)return;active=false;clearTimeout(timer);unlisten?.();window.removeEventListener('blur',close);
    dialog.close();dialog.remove();invoke('capture_shortcut',{enabled:false}).catch(()=>{});
  };
  const accept=next=>{
    if(!active || !ready)return;
    try{onAccept(next);close();}catch(e){error.textContent=String(e.message||e);}
  };
  cancel.onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};window.addEventListener('blur',close);
  dialog.addEventListener('keydown',event=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key==='Tab')return;
    if(event.key==='Enter' && event.target===cancel && !event.ctrlKey && !event.altKey && !event.metaKey)return;
    event.preventDefault();if(!ready)return;
    try{
      const next=shortcutFromEvent(event);
      output.textContent=next?shortcutLabel(next):[event.ctrlKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',event.metaKey?'Cmd / Win':'','…'].filter(Boolean).join(' + ');
      if(next)accept(next);
    }catch(e){error.textContent=e.message;}
  });
  try{
    unlisten=await subscribe('shortcut-captured',event=>accept(event.payload));
    if(!active){unlisten();return;}
    await invoke('capture_shortcut',{enabled:true});
    if(!active){await invoke('capture_shortcut',{enabled:false});return;}
    ready=true;output.textContent=shortcutLabel(value);timer=setTimeout(close,28000);
  }catch(error){close();throw error;}
}
