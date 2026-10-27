import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeShortcut,shortcutLabel,shortcutFromEvent,shortcutConflict,keyboardCode} from '../shortcuts.js';
import {seconds} from '../model.js';

test('physical keys work independently of keyboard layout and modifier order',()=>{
  assert.equal(shortcutFromEvent({code:'KeyR',key:'к',ctrlKey:true,shiftKey:true}),'Control+Shift+KeyR');
  assert.equal(normalizeShortcut('shift+ctrl+R'),normalizeShortcut('Control+Shift+KeyR'));
  assert.equal(normalizeShortcut('Cmd+2'),normalizeShortcut('Super+Digit2'));
  assert.equal(shortcutLabel('control+shift+KeyR'),'Ctrl + Shift + R');
  assert.equal(shortcutLabel('meta+KeyR',true),'⌘ Cmd + R');
  assert.equal(keyboardCode({code:'',keyCode:90,key:'я'}),'KeyZ');
  assert.equal(shortcutFromEvent({code:'',keyCode:121,key:'F10',ctrlKey:true,shiftKey:true}),'Control+Shift+F10');
  assert.equal(shortcutFromEvent({code:'',keyCode:17,key:'Control'}),null);
});
test('global shortcuts reject bare typing, AltGr and unsupported keys',()=>{
  for(const code of ['KeyA','Digit2','Space','Enter','Tab','Unidentified'])assert.throws(()=>shortcutFromEvent({code}));
  assert.equal(shortcutFromEvent({code:'F9'}),'F9');
  assert.equal(shortcutFromEvent({code:'PrintScreen'}),'PrintScreen');
  assert.equal(shortcutFromEvent({code:'ControlLeft'}),null);
  assert.equal(shortcutFromEvent({code:'F9',repeat:true}),null);
  assert.throws(()=>shortcutFromEvent({code:'KeyQ',ctrlKey:true,altKey:true,getModifierState:()=>true}));
  assert.equal(shortcutConflict({hotkey:'F9',stop_hotkey:'Ctrl+Shift+R',pause_hotkey:'F11'},'hotkey','Shift+Control+KeyR'),'Stop recording');
});
test('time labels omit padding while preserving millisecond precision',()=>{
  assert.deepEqual([0,4000000,500000,1250000,33333].map(seconds),['0','4','0.5','1.25','0.033']);
});
