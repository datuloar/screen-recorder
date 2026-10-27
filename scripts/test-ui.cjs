const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'target/ui-qa'));
const media = process.argv[3];
if (!media) throw Error('Usage: node scripts/test-ui.cjs OUTPUT_DIRECTORY TEST_MP4 (640x360, 4s, 30fps)');

async function fixture() {
  const settings = {schema_version:1,fps:30,bitrate_mbps:12,show_cursor:true,countdown_seconds:0,output_dir:'C:/UI-test/recordings',appearance:'Dark',hotkey:'Control+Shift+F9',stop_hotkey:'Control+Shift+F10',pause_hotkey:'Control+Shift+F11',start_in_tray:false,autostart:false,open_editor:true,audio:{system:false,microphone:false,system_device:null,microphone_device:null}};
  const document = {document_id:'ui-fixture',source:'test-recording.mp4',info:{width:640,height:360,fps:30,duration_us:4000000,audio:[{id:'embedded:0',stream:0,label:'Video audio 1'}]},project:{keep:[{start_us:0,end_us:4000000}],crop:null,muted:false,audio:[{track_id:'embedded:0',gain_db:0,muted:false}]},warnings:[]};
  const listeners = {};
  const query=new URLSearchParams(location.search);
  settings.language=query.get('preference') || 'System';
  window.qa = {settings,document,systemLanguage:query.get('system-language') || 'en-US',recordings:[],calls:[],status:{phase:'idle',elapsed_ms:0},emit:(event,payload)=>listeners[event]?.({payload})};
  window.__TAURI__ = {
    event:{listen:async(event,callback)=>{if(qa.failListen===event){qa.failListen=null;throw Error('Test: event connection failed');}listeners[event]=callback;return ()=>{};}},
    core:{convertFileSrc:()=>'/fixture.mp4',invoke:async(command,args)=>{
      qa.calls.push({command,args});
      if(qa.fail===command){qa.fail=null;throw Error('Test: action failed');}
      switch(command){
        case 'bootstrap': return {version:'0.1.0',system_language:qa.systemLanguage,settings,displays:[{id:1,name:'Display 1',width:1920,height:1080},{id:2,name:'Display 2',width:1080,height:1920}],system_devices:[{id:'',name:'Default device'},{id:'speakers',name:'Speakers'}],microphone_devices:[{id:'',name:'Default device'},{id:'mic',name:'Microphone USB'}],recordings:[]};
        case 'capture_status': return qa.status;
        case 'login_status': if(qa.holdLogin)await new Promise(resolve=>qa.releaseLogin=resolve);return qa.loginStatus || {registered:settings.autostart,current_executable:settings.autostart};
        case 'capture_controls_state': {
          const state={status:structuredClone(qa.status),appearance:settings.appearance,language:settings.language,system_language:qa.systemLanguage,stop_hotkey:settings.stop_hotkey,pause_hotkey:settings.pause_hotkey};
          if(qa.holdControls)await new Promise(resolve=>qa.releaseControls=resolve);
          return state;
        }
        case 'save_settings': if(qa.holdSettings)await new Promise(resolve=>qa.releaseSettings=resolve);Object.assign(settings,args.settings);return;
        case 'save_project': if(qa.holdSave)await new Promise(resolve=>qa.releaseSave=resolve);return;
        case 'apply_region': if(qa.holdRegion)await new Promise(resolve=>qa.releaseRegion=resolve);return;
        case 'choose_folder': return 'C:/UI-test/chosen';
        case 'recent_recordings': if(qa.delayLibrary)await new Promise(r=>setTimeout(r,250));return qa.recordings;
        case 'open_video': case 'open_recording': case 'open_pending': return document;
        case 'start_capture': qa.status={phase:'recording',elapsed_ms:1500,frames:45,dropped_frames:0,encoder:'Test encoder'};qa.emit('capture-status',qa.status);return;
        case 'pause_capture': qa.status.phase=qa.status.phase==='paused'?'recording':'paused';qa.emit('capture-status',qa.status);return;
        case 'stop_capture': qa.status.phase='idle';qa.emit('recording-finished',{open_editor:false});return;
        case 'export_video': return new Promise(resolve=>{qa.finishExport=resolve;});
        case 'cancel_export': qa.finishExport(null);return;
        case 'recover_entry': return new Promise(resolve=>{qa.finishRecovery=resolve;});
        case 'cancel_recovery': qa.finishRecovery(document);return;
        default:return;
      }
    }}
  };
}

(async()=>{
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined,headless:true});
  const page=await browser.newPage({viewport:{width:1080,height:920},reducedMotion:'reduce',locale:'en-US'});
  page.setDefaultTimeout(8000);
  const errors=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://screen-recorder.test/**',async route=>{
    const name=new URL(route.request().url()).pathname;
    if(name==='/fixture.mp4'){
      const data=await fs.readFile(media),match=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range||'');
      if(match){const start=Number(match[1]),end=Math.min(data.length-1,match[2]?Number(match[2]):data.length-1);return route.fulfill({status:206,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`},body:data.subarray(start,end+1)});}
      return route.fulfill({contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'},body:data});
    }
    const allowed={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/model.js':'model.js','/i18n.js':'i18n.js','/timeline.js':'timeline.js','/shortcuts.js':'shortcuts.js','/filmstrip.js':'filmstrip.js','/crop.js':'crop.js','/capture.html':'capture.html','/capture.js':'capture.js'};
    if(!allowed[name])return route.fulfill({status:404,body:''});
    await route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await fs.readFile(path.join(root,'ui',allowed[name]))});
  });
  await page.addInitScript(fixture);
  const click=async name=>page.getByRole('button',{name,exact:true}).click();
  const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
  const last=async command=>page.evaluate(c=>qa.calls.filter(x=>x.command===c).at(-1)?.args,command);
  const shot=async name=>page.screenshot({path:path.join(output,name+'.png'),fullPage:true});
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  try{
    await page.goto('http://screen-recorder.test/');
    await page.getByRole('heading',{name:'Record your screen',exact:true}).waitFor();
    await check('capture dimensions and display aspect ratio',async()=>{
      await page.getByLabel('Display',{exact:true}).selectOption('2');
      const r=await page.locator('.capture-diagram').boundingBox();assert.ok(Math.abs(r.width/r.height-1080/1920)<0.02);
      await page.getByLabel('Display',{exact:true}).selectOption('1');
      await page.getByText('Exact coordinates',{exact:true}).click();
      for(const [label,value] of [['Width','1280'],['Height','720'],['X, px','100'],['Y, px','80']]){await page.getByLabel(label,{exact:true}).fill(value);await page.getByLabel(label,{exact:true}).press('Tab');}
      assert.equal(await page.locator('.capture-dimensions').innerText(),'1280 × 720');
      await click('Select area');assert.equal((await last('select_area')).region.x,100);
      await page.getByText('Exact coordinates',{exact:true}).click();await shot('capture-dark');
      await click('Entire display');assert.equal(await page.locator('.capture-dimensions').innerText(),'1920 × 1080');
    });
    await check('quick audio persists and rolls back on error',async()=>{
      await page.getByLabel('System audio',{exact:true}).check();assert.equal((await last('save_settings')).settings.audio.system,true);
      await page.getByLabel('Microphone',{exact:true}).check();
      await page.evaluate(()=>qa.fail='save_settings');await page.getByLabel('Microphone',{exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Test:'));
      assert.equal(await page.getByLabel('Microphone',{exact:true}).isChecked(),true);
    });
    await check('capture start, pause, resume and stop',async()=>{
      await click('Start recording');await page.getByRole('heading',{name:'Recording'}).waitFor();await shot('recording-dark');
      await click('Compact controls');assert.ok(await page.evaluate(()=>qa.calls.some(c=>c.command==='compact_capture')));
      await click('Pause');await page.getByRole('heading',{name:'Paused'}).waitFor();await click('Resume');await click('Stop and save');
      await page.getByRole('heading',{name:'Record your screen',exact:true}).waitFor();
    });
    await check('settings fields, native-action binding, validation and all themes',async()=>{
      await click('Change settings');
      await page.getByLabel('Frame rate',{exact:true}).selectOption('60');await page.getByLabel('Bitrate, Mbps').fill('16');
      await page.getByLabel('Countdown, seconds').fill('3');await page.getByLabel('Show cursor in recording').uncheck();
      await page.getByLabel('Device',{exact:true}).nth(0).selectOption('speakers');await page.getByLabel('Device',{exact:true}).nth(1).selectOption('mic');
      for(const label of ['System audio','Microphone','Open editor after recording','Start minimized to tray','Launch at login'])await page.getByLabel(label,{exact:true}).click();
      for(const [label,value] of [['Select area','Control+Alt+F9'],['Stop recording','Control+Alt+F10'],['Pause / resume','Control+Alt+F11']]){await page.getByLabel(label,{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.shortcut-preview')?.textContent!=='Preparing shortcut input…');await page.keyboard.press(value);await page.getByRole('dialog').waitFor({state:'detached'});}
      await click('Recording folder');assert.equal(await page.locator('#output-path').innerText(),'C:/UI-test/chosen');
      await page.getByLabel('Bitrate, Mbps').fill('0');await click('Save settings');assert.equal(await page.getByLabel('Bitrate, Mbps').evaluate(e=>e.validity.valid),false);
      await page.getByLabel('Bitrate, Mbps').fill('16');
      for(const theme of ['System','Light','Dark']){
        await page.getByLabel('Theme',{exact:true}).selectOption(theme);await click('Save settings');await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme.toLowerCase());
        await noOverflow();await shot('settings-'+theme.toLowerCase());
      }
      assert.equal((await last('save_settings')).settings.fps,60);
    });
    await check('shortcut capture, duplicates, cancel, native event, reset and rollback',async()=>{
      const open=async label=>{await page.getByLabel(label,{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.shortcut-preview')?.textContent!=='Preparing shortcut input…');};
      const original=await page.getByLabel('Select area',{exact:true}).innerText();
      await open('Select area');await page.keyboard.press('a');assert.match(await page.locator('.shortcut-error').innerText(),/Add/);
      await page.keyboard.press('Control+Alt+F10');assert.match(await page.locator('.shortcut-error').innerText(),/Stop recording/);await shot('shortcut-capture-error');
      await page.keyboard.press('Escape');assert.equal(await page.getByLabel('Select area',{exact:true}).innerText(),original);assert.equal((await last('capture_shortcut')).enabled,false);
      await open('Select area');await page.evaluate(()=>qa.emit('shortcut-captured','shift+control+KeyR'));await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await page.getByLabel('Select area',{exact:true}).innerText(),'Ctrl + Shift + R');
      await page.evaluate(()=>qa.fail='save_settings');await click('Save settings');await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Test:'));assert.equal(await page.evaluate(()=>qa.settings.hotkey),'Control+Alt+F9');
      await page.getByRole('button',{name:'Reset: Select area',exact:true}).click();assert.equal(await page.getByLabel('Select area',{exact:true}).innerText(),'Ctrl + Shift + F9');
      await open('Select area');await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor({state:'detached'});
      await open('Select area');await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('dialog').waitFor({state:'detached'});assert.equal((await last('capture_shortcut')).enabled,false);
      await click('Save settings');assert.equal((await last('save_settings')).settings.hotkey,'Control+Shift+F9');
    });
    await check('countdown cancellation and keyboard focus',async()=>{
      await click('Record');await click('Start recording');await page.getByRole('button',{name:'Cancel',exact:true}).waitFor();await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Start recording',exact:true}).waitFor();
      await click('Start recording');await click('Cancel');await page.getByRole('button',{name:'Start recording',exact:true}).waitFor();
      await page.locator('#home-nav').focus();await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'recordings-nav');assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'solid');
    });
    await check('selection starts recording directly and countdown keeps focus until cancelled',async()=>{
      const before=await page.evaluate(()=>qa.calls.filter(c=>c.command==='start_capture').length);
      const region={x:40,y:60,width:640,height:360};
      await page.evaluate(region=>qa.emit('region-selected',{display_id:1,region,start_recording:false}),region);
      assert.equal(await page.locator('.capture-dimensions').innerText(),'640 × 360');
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.command==='start_capture').length),before);
      await page.evaluate(region=>{qa.emit('region-selected',{display_id:1,region,start_recording:true});},region);
      await page.getByText('Starting in 3…',{exact:true}).waitFor();await page.getByText('Starting in 2…',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Cancel');
      assert.equal(await page.locator('#home-nav').isDisabled(),true);
      await page.keyboard.press('Enter');await page.getByRole('button',{name:'Start recording',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Start recording');
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.command==='start_capture').length),before);
      await page.evaluate(region=>{qa.emit('region-selected',{display_id:1,region,start_recording:true});qa.emit('region-selected',{display_id:1,region,start_recording:true});},region);
      await page.getByRole('heading',{name:'Recording',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.command==='start_capture').length),before+1);
      assert.deepEqual((await last('start_capture')).region,region);await click('Stop and save');
      await page.evaluate(region=>{qa.fail='start_capture';qa.emit('region-selected',{display_id:1,region,start_recording:true});},region);
      await page.getByRole('button',{name:'Start recording',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('#home-nav').disabled);
      assert.ok((await page.locator('#notice').innerText()).includes('Test:'));await noOverflow();
    });
    await check('library empty, loading, rows, reveal and recovery actions',async()=>{
      await click('Recordings');await page.getByRole('heading',{name:'Your recordings will appear here'}).waitFor();await shot('library-empty');await click('Record screen');
      await page.evaluate(()=>{qa.delayLibrary=true;qa.recordings=[{id:'saved',started_ms:1792742400000,bytes:1048576,elapsed_ms:4000,source_exists:true},{id:'broken',bytes:524288,needs_recovery:true,source_exists:true},{id:'missing',bytes:0,source_exists:false}];});
      await click('Recordings');await page.getByText('Loading recordings…').waitFor();await page.locator('.recording-item').nth(2).waitFor();
      await click('Refresh');await page.locator('.recording-item').nth(2).waitFor();
      await page.getByRole('button',{name:'Show folder',exact:true}).first().click();assert.equal((await last('reveal_recording')).id,'saved');
      await shot('library-dark');await click('Open original');await page.locator('video').waitFor();await click('Recordings');
      await click('Recover copy');await click('Cancel recovery');await page.locator('video').waitFor();
      await click('Recordings');await page.getByRole('button',{name:'Open',exact:true}).first().click();await page.locator('video').waitFor();
      await page.evaluate(()=>qa.recordings[1].recovery_copy='recovered');await click('Recordings');await click('Open recovered copy');assert.equal((await last('open_recording')).id,'recovered');
    });
    await click('Open video');
    await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
    const selectRange=async(start,end,total=4)=>{
      await page.locator('.timeline-zoom button').first().click();await page.locator('.timeline-scroll').scrollIntoViewIfNeeded();
      const bounds=await page.locator('.timeline-track').boundingBox();
      await page.mouse.move(bounds.x+bounds.width*start/total,bounds.y+bounds.height/2);await page.mouse.down();
      await page.mouse.move(bounds.x+bounds.width*end/total,bounds.y+bounds.height/2,{steps:10});await page.mouse.up();
    };
    const selection=async()=>Promise.all(['Selection start','Selection end'].map(name=>page.getByRole('slider',{name,exact:true}).getAttribute('aria-valuenow').then(Number)));
    await check('mouse selection and handles without time inputs',async()=>{
      await page.waitForFunction(()=>[...document.querySelectorAll('.clip-filmstrip img')].some(img=>img.naturalWidth===160));
      assert.equal(await page.locator('input[inputmode=decimal]').count(),0);
      await selectRange(.5,1.5);assert.deepEqual(await selection(),[.5,1.5]);
      const handle=await page.getByRole('slider',{name:'Selection end',exact:true}).boundingBox(),bounds=await page.locator('.timeline-track').boundingBox();
      await page.mouse.move(handle.x+handle.width/2,handle.y+30);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2,handle.y+30,{steps:8});await page.mouse.up();
      assert.equal((await selection())[1],2);
      await page.getByRole('slider',{name:'Selection start',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.ok((await selection())[0]>.5);
      await page.keyboard.press('Escape');assert.equal(await page.locator('.timeline-range').isVisible(),false);
      await page.locator('.timeline-clip').focus();await page.keyboard.press('Enter');assert.equal(await page.getByRole('button',{name:'Delete selection',exact:true}).isDisabled(),true);
      await click('Clear selection');
    });
    await check('mouse edits across cuts, retain, undo and redo',async()=>{
      const ruler=page.locator('.timeline-ruler'),bounds=await ruler.boundingBox();await ruler.click({position:{x:bounds.width/2,y:20}});await click('Split at playhead');assert.equal(await page.locator('.timeline-clip').count(),2);
      await page.locator('.timeline-clip').last().click();await click('Delete selection');assert.equal(await page.locator('.timeline-clip').count(),1);await click('Undo');await click('Redo');await click('Undo');
      await selectRange(.5,3);await click('Delete selection');await click('Save project');
      let saved=(await last('save_project')).project.keep;assert.deepEqual(saved,[{start_us:0,end_us:500000},{start_us:3000000,end_us:4000000}]);
      await selectRange(.3,1,1.5);await click('Keep selection');await click('Save project');saved=(await last('save_project')).project.keep;
      assert.deepEqual(saved,[{start_us:300000,end_us:500000},{start_us:3000000,end_us:3500000}]);
      assert.equal(await page.locator('video').evaluate(video=>video.currentTime),.3);
      await fs.writeFile(path.join(output,'timeline-project.json'),JSON.stringify({...await page.evaluate(()=>qa.document.project),keep:saved},null,2));
      await click('Undo');await click('Undo');await page.locator('.timeline-clip').last().focus();await page.keyboard.press('Enter');await page.keyboard.press('Delete');assert.equal(await page.locator('.timeline-clip').count(),1);await click('Undo');
    });
    await check('context menu, mouse zoom, selection preview and cut navigation',async()=>{
      await selectRange(.5,1.5);const before=await selection();
      await page.locator('.timeline-track').click({button:'right',position:{x:200,y:30}});
      const menu=page.getByRole('dialog',{name:'Edit menu'});await menu.waitFor();await shot('context-menu-dark');
      await page.keyboard.press('Escape');assert.deepEqual(await selection(),before);
      await page.locator('.timeline-scroll').focus();await page.keyboard.press('Shift+F10');await menu.getByRole('button',{name:'Zoom to selection',exact:true}).click();assert.notEqual(await page.locator('.timeline-zoom output').innerText(),'100%');
      await click('Fit');await page.locator('.timeline-scroll').hover();await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await page.waitForFunction(()=>document.querySelector('.timeline-zoom output').textContent==='150%');
      await click('Fit');await click('Preview selection');await page.waitForFunction(()=>document.querySelector('video').currentTime>1.3 && document.querySelector('video').paused);assert.ok(await page.locator('video').evaluate(v=>v.currentTime<1.6));
      await click('Next cut');assert.equal(await page.locator('video').evaluate(v=>v.currentTime),2);await click('Previous cut');assert.equal(await page.locator('video').evaluate(v=>v.currentTime),0);
      await page.locator('.timeline-scroll').focus();await page.keyboard.press('Escape');await page.keyboard.press('i');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('o');const marked=await selection();assert.equal(marked[0],0);assert.ok(marked[1]>.3 && marked[1]<.4);
      await page.keyboard.press('Control+s');assert.ok(await last('save_project'));
      await page.keyboard.press('Control+Shift+s');await page.getByRole('button',{name:'Cancel export'}).waitFor();assert.equal(await page.getByLabel('Timeline zoom').isDisabled(),true);await click('Cancel export');
    });
    await check('selection snaps to cuts, Alt and toggle bypass it, guide clears on cancel',async()=>{
      await selectRange(.5,1.5);const track=await page.locator('.timeline-track').boundingBox();
      const dragEnd=async(offset,alt=false)=>{
        const h=await page.getByRole('slider',{name:'Selection end',exact:true}).boundingBox();
        if(alt)await page.keyboard.down('Alt');
        await page.mouse.move(h.x+h.width/2,h.y+30);await page.mouse.down();await page.mouse.move(track.x+track.width/2-40,h.y+30,{steps:4});await page.mouse.move(track.x+track.width/2+offset,h.y+30,{steps:8});
      };
      await dragEnd(6);assert.equal((await selection())[1],2);assert.equal(await page.locator('.timeline-snap-guide').innerText(),'Cut');await shot('timeline-snapping');await page.mouse.up();assert.equal(await page.locator('.timeline-snap-guide').isVisible(),false);
      await dragEnd(6,true);assert.ok((await selection())[1]>2);assert.equal(await page.locator('.timeline-snap-guide').isVisible(),false);await page.mouse.up();await page.keyboard.up('Alt');
      await click('Snap');assert.equal(await page.getByRole('button',{name:'Snap',exact:true}).getAttribute('aria-pressed'),'false');
      await dragEnd(-6);assert.ok((await selection())[1]<2);await page.mouse.up();await click('Snap');
      const previous=await selection();await dragEnd(5);await page.locator('.timeline-canvas').dispatchEvent('pointercancel');await page.mouse.up();assert.deepEqual(await selection(),previous);assert.equal(await page.locator('.timeline-snap-guide').isVisible(),false);
      await page.locator('video').evaluate(v=>v.currentTime=1.2345678);await page.waitForFunction(()=>!document.querySelector('video').seeking);
      const h=await page.getByRole('slider',{name:'Selection end',exact:true}).boundingBox();await page.mouse.move(h.x+h.width/2,h.y+30);await page.mouse.down();await page.mouse.move(track.x+track.width*1.24/4,h.y+30,{steps:8});
      assert.equal(await page.locator('.timeline-snap-guide').innerText(),'Playhead');assert.equal((await selection())[1],1.233333);await page.mouse.up();
    });
    await check('selected export crosses removed gaps without changing montage or history',async()=>{
      await selectRange(1,2);await click('Delete selection');await click('Save project');const before=(await last('save_project')).project;
      await selectRange(.5,1.5,3);const selected=await selection();await click('Export selection');await page.getByRole('button',{name:'Cancel export'}).waitFor();
      const sent=await last('export_video');assert.equal(sent.selection,true);assert.deepEqual(sent.project.keep,[{start_us:500000,end_us:1000000},{start_us:2000000,end_us:2500000}]);
      assert.equal(await page.getByRole('button',{name:'Snap',exact:true}).isDisabled(),true);assert.equal(await page.locator('#open-nav').isDisabled(),true);
      await fs.writeFile(path.join(output,'selected-export.json'),JSON.stringify(sent.project,null,2));
      await page.evaluate(()=>qa.finishExport('C:/UI-test/a very long recording folder with spaces/meeting-clip.mp4'));await page.getByRole('heading',{name:'Selection exported'}).waitFor();
      assert.equal(await page.locator('.editor-workspace').evaluate(e=>e.scrollTop),0);
      assert.deepEqual(await selection(),selected);await click('Save project');assert.deepEqual((await last('save_project')).project,before);
      for(const theme of ['dark','light'])for(const width of [1080,620,360]){await page.setViewportSize({width,height:920});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await noOverflow();await shot(`export-${theme}-${width}`);}
      await page.setViewportSize({width:1080,height:920});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
      await click('Undo');await click('Save project');assert.deepEqual((await last('save_project')).project.keep,[{start_us:0,end_us:2000000},{start_us:2000000,end_us:4000000}]);
      await selectRange(.5,1.5);await page.locator('.timeline-scroll').focus();await page.keyboard.press('Shift+F10');await page.getByRole('dialog').getByRole('button',{name:'Export selection',exact:true}).click();await click('Cancel export');await page.getByText('Export cancelled',{exact:true}).waitFor();
      assert.deepEqual(await selection(),[.5,1.5]);await click('Clear selection');assert.equal(await page.getByRole('button',{name:'Export selection',exact:true}).isDisabled(),true);
    });
    await check('timeline edge autoscroll and pointer cancellation',async()=>{
      await selectRange(.5,1.5);
      await page.getByLabel('Timeline zoom').fill('4');const scroll=page.locator('.timeline-scroll');await scroll.scrollIntoViewIfNeeded();const bounds=await scroll.boundingBox(),before=await scroll.evaluate(e=>e.scrollLeft),selected=await selection();
      await page.mouse.move(bounds.x+50,bounds.y+90);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width-5,bounds.y+90,{steps:8});await page.waitForFunction(value=>document.querySelector('.timeline-scroll').scrollLeft>value,before);
      await page.locator('.timeline-canvas').dispatchEvent('pointercancel');await page.mouse.up();assert.deepEqual(await selection(),selected);await click('Fit');
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);await page.evaluate(()=>document.querySelector('#notice').hidden=true);await shot('timeline-dark');
    });
    await check('editor playback, mouse trimming and history',async()=>{
      await click('Show folder');assert.ok(await page.evaluate(()=>qa.calls.some(c=>c.command==='reveal_project')));
      await click('Play');await page.waitForFunction(()=>document.querySelector('video').currentTime>.1);await click('Pause');await click('Next frame');await click('Previous frame');
      await selectRange(.5,3.5);await click('Keep selection');assert.equal(await page.locator('.timeline-clip small').innerText(),'0.5…3.5 s');await click('Undo');await click('Redo');
      await selectRange(.5,1.5,3);await click('Delete selection');assert.equal(await page.locator('.timeline-clip').count(),2);await click('Undo');
    });
    await check('autosave reports pending, failed and saved revisions with retry',async()=>{
      await page.getByText('Edits saved',{exact:true}).waitFor();
      await page.evaluate(()=>{qa.holdSave=true;qa.releaseSave=null;});
      await selectRange(.5,1,3);await click('Delete selection');await page.getByText('Saving edits…',{exact:true}).waitFor();
      await page.waitForFunction(()=>!!qa.releaseSave);await click('Undo');
      await page.evaluate(()=>{qa.releaseSave();qa.releaseSave=null;});await page.waitForFunction(()=>!!qa.releaseSave);
      assert.equal(await page.locator('.save-status').innerText(),'Saving edits…');
      await page.evaluate(()=>{qa.holdSave=false;qa.releaseSave();});await page.getByText('Edits saved',{exact:true}).waitFor();
      await page.evaluate(()=>qa.fail='save_project');await selectRange(.5,1,3);await click('Delete selection');await page.getByText('Edits not saved: Test: action failed',{exact:true}).waitFor();
      await shot('autosave-error');await page.evaluate(()=>qa.fail='save_project');await click('Record');
      assert.equal(await page.locator('#content').getAttribute('data-page'),'editor');
      await click('Retry save');await page.getByText('Edits saved',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Retry save',exact:true}).isVisible(),false);
      assert.equal(await page.locator('.save-status').evaluate(e=>e===document.activeElement),true);
      assert.deepEqual((await last('save_project')).project.keep,[{start_us:500000,end_us:1000000},{start_us:1500000,end_us:3500000}]);
      await click('Undo');await page.getByText('Edits saved',{exact:true}).waitFor();
    });
    const drawCrop=async()=>{
      const stage=page.locator('.crop-stage');await stage.scrollIntoViewIfNeeded();const b=await stage.boundingBox();
      await page.mouse.move(b.x+b.width*.25,b.y+b.height*.25);await page.mouse.down();await page.mouse.move(b.x+b.width*.75,b.y+b.height*.75,{steps:8});await page.mouse.up();
    };
    await check('visual crop draws on video, applies, cancels and restores through history',async()=>{
      await page.getByText('Crop',{exact:true}).click();await click('Crop video');const modal=page.getByRole('dialog',{name:'Crop video'});await modal.waitFor();
      assert.equal(await modal.locator('input').count(),0);assert.equal(await modal.getByRole('button',{name:'Apply',exact:true}).isDisabled(),true);
      const time=await page.locator('video').evaluate(video=>video.currentTime);await drawCrop();await shot('crop-selection-dark');
      assert.equal(await page.locator('.crop-status').innerText(),'320 × 180 px · position 160, 90');
      await click('Apply');await click('Save project');assert.deepEqual((await last('save_project')).project.crop,{x:160,y:90,width:320,height:180});
      assert.equal(await page.locator('.player-viewport video').evaluate(e=>e.style.width),'200%');assert.equal(await page.locator('video').evaluate(v=>v.currentTime),time);
      await click('Undo');assert.equal(await page.locator('video').evaluate(e=>e.style.width),'100%');await click('Redo');
      await page.locator('.player-viewport').dblclick();await page.locator('.crop-box').waitFor();
      const box=await page.locator('.crop-box').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+30,box.y+box.height/2+20,{steps:5});await page.mouse.up();
      await page.keyboard.press('Escape');await click('Save project');assert.deepEqual((await last('save_project')).project.crop,{x:160,y:90,width:320,height:180});
      assert.equal(await page.locator('.player-viewport video').count(),1);
    });
    await check('crop handles, keyboard, bounds, pointer cancellation and full-frame reset',async()=>{
      await click('Crop video');
      const original=await page.locator('.crop-status').innerText();
      let handle=await page.getByRole('button',{name:'Bottom right corner',exact:true}).boundingBox();await page.mouse.move(handle.x+22,handle.y+22);await page.mouse.down();await page.mouse.move(handle.x+75,handle.y+75,{steps:4});await page.locator('.crop-stage').dispatchEvent('pointercancel');await page.mouse.up();assert.equal(await page.locator('.crop-status').innerText(),original);
      await page.getByRole('button',{name:'Right edge',exact:true}).focus();await page.keyboard.press('Shift+ArrowRight');assert.match(await page.locator('.crop-status').innerText(),/^330 × 180/);
      await page.locator('.crop-box').focus();await page.keyboard.press('ArrowRight');assert.match(await page.locator('.crop-status').innerText(),/162, 90$/);
      await click('Cancel');
      for(const [edge,label,dx,dy] of [['nw','Top left corner',-900,-900],['n','Top edge',0,-900],['ne','Top right corner',900,-900],['e','Right edge',900,0],['se','Bottom right corner',900,900],['s','Bottom edge',0,900],['sw','Bottom left corner',-900,900],['w','Left edge',-900,0]]){
        await click('Crop video');handle=await page.getByRole('button',{name:label,exact:true}).boundingBox();
        await page.mouse.move(handle.x+22,handle.y+22);await page.mouse.down();await page.mouse.move(handle.x+22+dx,handle.y+22+dy,{steps:4});await page.mouse.up();
        const values=(await page.locator('.crop-status').innerText()).match(/\d+/g).map(Number),[width,height,x,y]=values;
        assert.ok(width>=2 && height>=2 && x>=0 && y>=0 && x+width<=640 && y+height<=360,edge);assert.equal(width%2,0);assert.equal(height%2,0);
        await click('Cancel');
      }
      await click('Crop video');await click('Draw again');assert.equal(await page.locator('.crop-box').isVisible(),false);await click('Full frame');await click('Apply');await click('Save project');assert.equal((await last('save_project')).project.crop,null);
      await click('Crop video');await drawCrop();await page.locator('.crop-stage').focus();await page.keyboard.press('Enter');await click('Export MP4');await page.getByRole('button',{name:'Cancel export'}).waitFor();assert.deepEqual((await last('export_video')).project.crop,{x:160,y:90,width:320,height:180});await click('Cancel export');
      await click('Reset crop');assert.equal(await page.locator('video').evaluate(e=>e.style.width),'100%');await page.getByText('Crop',{exact:true}).click();
    });
    await check('crop dialog fits small viewports, both themes and restores video',async()=>{
      for(const theme of ['dark','light'])for(const width of [1080,620,360]){
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.setViewportSize({width,height:748});await page.locator('.player-viewport').dblclick();await drawCrop();await noOverflow();
        const bounds=await page.locator('.crop-dialog').boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);assert.equal(await page.locator('.crop-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);
        await shot(`crop-${theme}-${width}`);await click('Cancel');assert.equal(await page.locator('.player-viewport video').count(),1);
      }
      await page.setViewportSize({width:620,height:748});await page.evaluate(()=>document.documentElement.style.fontSize='28px');await page.locator('.player-viewport').dblclick();
      assert.equal(await page.locator('.crop-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);await page.keyboard.press('Escape');await page.evaluate(()=>{document.documentElement.style.fontSize='';document.documentElement.dataset.theme='dark';});
      await page.setViewportSize({width:1080,height:920});
    });
    await check('crop errors keep cancellation available and leaving editor cleans up the dialog',async()=>{
      await page.locator('.player-viewport').dblclick();await page.locator('.crop-video-layer video').dispatchEvent('error');await page.getByText('Could not load the frame. Close this dialog and try another video.').waitFor();
      assert.equal(await page.getByRole('button',{name:'Apply',exact:true}).isDisabled(),true);await click('Cancel');
      await page.locator('.player-viewport').dblclick();await page.evaluate(()=>qa.emit('navigate','home'));await page.getByRole('heading',{name:'Record your screen',exact:true}).waitFor();assert.equal(await page.locator('.crop-dialog').count(),0);
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
    });
    await check('audio mix, save, export progress and cancellation',async()=>{
      await page.locator('.edit-tool summary').filter({hasText:/^Audio$/}).click();await page.getByLabel('Mute all audio',{exact:true}).check();await page.getByLabel('Mute all audio',{exact:true}).uncheck();await page.getByLabel('Video audio 1',{exact:true}).uncheck();await page.getByLabel('Volume: Video audio 1').fill('-6');
      await click('Save project');assert.equal((await last('save_project')).project.audio[0].gain_db,-6);
      await page.locator('.edit-tool summary').filter({hasText:/^Audio$/}).click();
      await click('Export MP4');await page.getByRole('button',{name:'Cancel export'}).waitFor();assert.equal(await page.getByRole('button',{name:'Save project',exact:true}).isDisabled(),true);
      await page.evaluate(()=>qa.emit('export-progress',0.5));assert.equal(await page.getByRole('progressbar').getAttribute('value'),'0.5');await click('Cancel export');await page.getByText('Export cancelled',{exact:true}).waitFor();
      await click('Export MP4');await page.waitForFunction(()=>!!qa.finishExport);await page.evaluate(()=>qa.finishExport('C:/UI-test/export.mp4'));await page.getByRole('heading',{name:'Video exported',exact:true}).waitFor();
      await page.locator('.export-state').getByRole('button',{name:'Open video',exact:true}).click();assert.deepEqual(await last('open_export'),{folder:false});
      await click('Open folder');assert.deepEqual(await last('open_export'),{folder:true});
      await page.evaluate(()=>qa.fail='open_export');await click('Open folder');assert.equal(await page.locator('.export-path').innerText(),'C:/UI-test/export.mp4');
      await page.evaluate(()=>qa.fail='export_video');await click('Export MP4');await page.getByText('Could not export MP4. Try exporting again.',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Export MP4',exact:true}).isEnabled(),true);assert.equal(await page.getByRole('progressbar').count(),0);
    });
    await check('editor keyboard playback, frame stepping, history and disclosure',async()=>{
      const details=page.locator('.edit-tool').nth(1);
      await details.locator('summary').focus();await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),'');
      await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),null);
      await page.locator('#content').focus();await page.keyboard.press('Space');await page.getByRole('button',{name:'Pause',exact:true}).waitFor();await page.keyboard.press('Space');
      await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Control+z');await page.keyboard.press('Control+Shift+z');

    });
    await check('pending playback starts once and cannot resume after leaving the editor',async()=>{
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await page.evaluate(()=>{
        qa.originalResume=AudioContext.prototype.resume;
        qa.originalPlay=HTMLMediaElement.prototype.play;
        qa.playCalls=0;
        AudioContext.prototype.resume=function(){return new Promise(resolve=>qa.releaseAudio=resolve);};
        HTMLMediaElement.prototype.play=function(){qa.playCalls++;return qa.originalPlay.call(this);};
      });
      await click('Play');await page.waitForFunction(()=>!!qa.releaseAudio);
      await page.locator('#content').focus();await page.keyboard.press('Space');
      assert.equal(await page.getByRole('button',{name:'Play',exact:true}).isDisabled(),true);
      await click('Record');
      await page.evaluate(()=>{qa.releaseAudio();AudioContext.prototype.resume=qa.originalResume;HTMLMediaElement.prototype.play=qa.originalPlay;});
      await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>qa.playCalls),0);
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await click('Play');await page.getByRole('button',{name:'Pause',exact:true}).waitFor();await click('Pause');
    });
    await check('preview speed changes playback without changing the saved or exported project',async()=>{
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await page.getByLabel('Preview speed',{exact:true}).selectOption('0.5');
      await click('Play');await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
      assert.equal(await page.locator('video').evaluate(v=>v.playbackRate),.5);await click('Pause');
      await page.getByLabel('Preview speed',{exact:true}).selectOption('2');
      await click('Save project');const saved=(await last('save_project')).project;
      assert.deepEqual(saved,await page.evaluate(()=>qa.document.project));
      await click('Export MP4');await page.getByRole('button',{name:'Cancel export'}).waitFor();
      assert.equal(await page.getByLabel('Preview speed',{exact:true}).isDisabled(),true);
      assert.deepEqual((await last('export_video')).project,saved);await click('Cancel export');
      await page.waitForFunction(()=>!document.querySelector('.preview-speed select').disabled);
      assert.equal(await page.getByLabel('Preview speed',{exact:true}).inputValue(),'2');
    });
    const watchLoops=async threshold=>page.evaluate(threshold=>{
      const video=document.querySelector('video');qa.loopReturns=0;let previous=null;
      const sample=()=>{if(!video.paused){if(previous>=threshold && video.currentTime<threshold)qa.loopReturns++;previous=video.currentTime;}else previous=null;qa.loopFrame=requestAnimationFrame(sample);};sample();
    },threshold);
    await check('selection loops across removed gaps and stops when cleared or loop is turned off',async()=>{
      await selectRange(1,2);await click('Delete selection');await selectRange(.5,1.5,3);
      await click('Loop selection preview');assert.equal(await page.getByRole('button',{name:'Loop selection preview'}).getAttribute('aria-pressed'),'true');
      await watchLoops(2);await click('Preview selection');
      await page.waitForFunction(()=>qa.loopReturns>=2);await click('Loop selection preview');
      await page.waitForFunction(()=>document.querySelector('video').paused);
      assert.ok(await page.locator('video').evaluate(v=>v.currentTime>=2.4 && v.currentTime<2.5));
      await click('Loop selection preview');await click('Preview selection');await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
      await click('Clear selection');assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
      assert.equal(await page.getByRole('button',{name:'Loop selection preview'}).isDisabled(),true);
      await page.evaluate(()=>cancelAnimationFrame(qa.loopFrame));
    });
    await check('loop preview restarts at the physical file end and pause stays final',async()=>{
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await page.getByLabel('Preview speed',{exact:true}).selectOption('2');await selectRange(3,4);
      await click('Loop selection preview');await watchLoops(3.8);await click('Preview selection');
      await page.waitForFunction(()=>qa.loopReturns>=2);await click('Pause');
      const stopped=await page.locator('video').evaluate(v=>v.currentTime);await page.waitForTimeout(150);
      assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
      assert.ok(Math.abs(await page.locator('video').evaluate(v=>v.currentTime)-stopped)<.04);
      await page.evaluate(()=>cancelAnimationFrame(qa.loopFrame));await click('Clear selection');
    });
    await check('zoomed timeline follows playback and leaves paused scrolling alone',async()=>{
      await page.locator('#content').focus();await page.keyboard.press('Home');await page.getByLabel('Timeline zoom').fill('4');
      await click('Play');await page.waitForFunction(()=>document.querySelector('.timeline-scroll').scrollLeft>100);
      const visible=await page.evaluate(()=>{const head=document.querySelector('.timeline-playhead').getBoundingClientRect(),view=document.querySelector('.timeline-scroll').getBoundingClientRect();return head.x>=view.x && head.x<=view.right;});assert.equal(visible,true);
      await click('Pause');await page.evaluate(()=>{document.querySelector('.timeline-scroll').scrollLeft=0;document.querySelector('video').currentTime=3;});
      await page.waitForTimeout(100);assert.equal(await page.locator('.timeline-scroll').evaluate(e=>e.scrollLeft),0);
      await click('Fit');await page.getByLabel('Preview speed',{exact:true}).selectOption('1');
    });
    await check('light/dark layouts at 1080, 900, 620 and 360 CSS px',async()=>{
      await page.evaluate(()=>{document.querySelector('#notice').hidden=true;});
      for(const theme of ['dark','light'])for(const width of [1080,900,620,360]){
        await page.setViewportSize({width,height:748});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await noOverflow();
        assert.ok((await page.locator('.player-viewport').boundingBox()).height>=200 || width<981);
        if(width<981)assert.ok((await page.locator('.timeline-editor').boundingBox()).y<(await page.locator('.editor-inspector').boundingBox()).y);
        await shot(`editor-${theme}-${width}`);
      }
      for(const section of ['Record','Settings','Recordings']){
        await click(section);
        for(const theme of ['dark','light'])for(const width of [1080,620,360]){
          await page.setViewportSize({width,height:748});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await noOverflow();
          await shot(`${section}-${theme}-${width}`);
        }
      }
    });
    await check('reduced motion, quit binding and no uncaught JS errors',async()=>{
      assert.equal(await page.locator('#home-nav').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await click('Quit');assert.ok(await page.evaluate(()=>qa.calls.some(c=>c.command==='quit')));assert.deepEqual(errors,[]);
    });
    await check('200 percent text size has no horizontal overflow',async()=>{
      await page.setViewportSize({width:620,height:748});await page.evaluate(()=>document.documentElement.style.fontSize='28px');
      for(const section of ['Record','Settings','Recordings','Open video']){await click(section);await noOverflow();}
      await page.evaluate(()=>document.documentElement.style.fontSize='');
    });
    await check('selection overlay drag, eight handles, numeric fields and keyboard',async()=>{
      await page.setViewportSize({width:1080,height:748});
      await page.goto('http://screen-recorder.test/?overlay=1&width=1920&height=1080&display=1');
      await page.locator('.selection-stage').waitFor();await page.mouse.move(100,120);await page.mouse.down();await page.mouse.move(600,400);await page.mouse.up();
      for(const handle of ['nw','n','ne','e','se','s','sw','w']){
        const box=await page.locator(`[data-handle=${handle}]`).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+8,box.y+box.height/2+8);await page.mouse.up();
      }
      const box=await page.locator('.selection-box').boundingBox();await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+50,box.y+40);await page.mouse.up();
      await page.getByText('Exact coordinates',{exact:true}).click();
      for(const [label,value] of [['X, px','100'],['Y, px','100'],['Width','640'],['Height','360']]){
        await page.getByLabel(label,{exact:true}).fill(value);
        await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
        assert.equal(await page.getByLabel(label,{exact:true}).inputValue(),value);
        await page.getByLabel(label,{exact:true}).press('Tab');
      }
      assert.equal(await page.getByLabel('X, px',{exact:true}).inputValue(),'100');
      await click('Use area');assert.deepEqual((await last('apply_region')).region,{x:100,y:100,width:640,height:360});assert.equal((await last('apply_region')).startRecording,false);
      await page.locator('.selection-box').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Shift+ArrowDown');await page.keyboard.press('Alt+ArrowRight');await page.keyboard.press('Enter');
      assert.equal((await last('apply_region')).region.x,101);assert.equal((await last('apply_region')).region.y,110);assert.equal((await last('apply_region')).startRecording,true);
      await page.keyboard.press('Escape');await click('Cancel');assert.ok(await page.evaluate(()=>qa.calls.filter(c=>c.command==='cancel_selection').length>=2));
      await shot('selection-overlay');assert.deepEqual(errors,[]);
    });
    await check('selection errors remain visible, submits once and cancelled drags restore the rectangle',async()=>{
      await page.goto('http://screen-recorder.test/?overlay=1&width=1920&height=1080&display=1&x=100&y=100&w=640&h=360');
      await page.locator('.selection-box').waitFor();const original=await page.locator('.selection-box').getAttribute('style');
      const box=await page.locator('.selection-box').boundingBox();await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+90,box.y+90);
      await page.locator('.selection-stage').dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();
      assert.equal(await page.locator('.selection-box').getAttribute('style'),original);
      await page.mouse.click(1000,600,{button:'right'});assert.equal(await page.locator('.selection-box').getAttribute('style'),original);
      await page.evaluate(()=>qa.fail='apply_region');await click('Record area');
      assert.ok((await page.locator('.selection-feedback').innerText()).includes('Test:'));await noOverflow();
      await page.evaluate(()=>qa.holdRegion=true);await click('Record area');
      await page.waitForFunction(()=>!!qa.releaseRegion);const calls=await page.evaluate(()=>qa.calls.filter(c=>c.command==='apply_region').length);
      await page.keyboard.press('Enter');await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.command==='apply_region').length),calls);assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
      await page.evaluate(()=>{qa.holdRegion=false;qa.releaseRegion();});await page.waitForFunction(()=>!document.querySelector('.selection-toolbar button').disabled);
      await page.evaluate(()=>qa.fail='cancel_selection');await click('Cancel');assert.equal(await page.locator('.selection-feedback').isVisible(),true);
      for(const width of [620,360]){await page.setViewportSize({width,height:748});await page.getByText('Exact coordinates',{exact:true}).click();await noOverflow();await shot(`quick-record-${width}`);await page.getByText('Exact coordinates',{exact:true}).click();}
      await page.evaluate(()=>document.documentElement.style.fontSize='28px');await page.getByText('Exact coordinates',{exact:true}).click();await noOverflow();
      await page.getByLabel('Height',{exact:true}).scrollIntoViewIfNeeded();await page.getByLabel('Height',{exact:true}).fill('200');await page.getByLabel('Height',{exact:true}).press('Tab');await noOverflow();
      const toolbar=await page.locator('.selection-toolbar').boundingBox();assert.ok(toolbar.y>=0 && toolbar.y+toolbar.height<=748);await shot('quick-record-large-text');await click('Use area');assert.equal((await last('apply_region')).startRecording,false);
      await page.goto('http://screen-recorder.test/?overlay=1&width=1920&height=1080&display=1');
      await page.locator('.selection-stage').waitFor();await page.evaluate(()=>qa.fail='cancel_selection');await page.keyboard.press('Escape');await page.locator('.selection-feedback').waitFor();
      assert.ok((await page.locator('.selection-feedback').innerText()).includes('Test:'));assert.deepEqual(errors,[]);
    });
    await check('compact capture controls, states, errors and keyboard',async()=>{
      await page.setViewportSize({width:480,height:152});await page.goto('http://screen-recorder.test/capture.html');
      await page.getByText('Recording finished',{exact:true}).waitFor();
      assert.equal(await page.locator('#capture-pause').isDisabled(),true);assert.equal(await page.locator('#capture-stop').isDisabled(),true);
      await page.evaluate(()=>{qa.status={phase:'preparing',elapsed_ms:0};qa.emit('capture-status',qa.status);});
      assert.equal(await page.locator('#capture-pause').isDisabled(),true);assert.equal(await page.locator('#capture-stop').isEnabled(),true);
      await page.evaluate(()=>{qa.status={phase:'recording',elapsed_ms:65000};qa.emit('capture-status',qa.status);});
      assert.equal(await page.locator('#capture-time').innerText(),'01:05');
      await page.locator('#capture-pause').focus();await page.keyboard.press('Enter');await page.getByText('Paused',{exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('#capture-pause').disabled);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'capture-pause');
      await page.keyboard.press('Space');await page.getByText('Recording',{exact:true}).waitFor();
      await page.evaluate(()=>qa.fail='pause_capture');await click('Pause');await page.getByText('Reconnect',{exact:true}).waitFor();
      assert.ok((await page.locator('#capture-error').innerText()).includes('Test:'));assert.equal(await page.locator('#capture-stop').isEnabled(),true);
      await click('Reconnect');assert.equal(await page.locator('#capture-error').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'capture-phase');
      await click('Expand');assert.ok(await page.evaluate(()=>qa.calls.some(c=>c.command==='expand_capture')));
      await page.evaluate(()=>qa.fail='expand_capture');await click('Expand');assert.equal(await page.locator('#capture-error').isVisible(),true);
      await page.evaluate(()=>{qa.emit('capture-controls-refresh');qa.status={phase:'saving',elapsed_ms:65000};qa.emit('capture-status',qa.status);});
      assert.equal(await page.locator('#capture-pause').isDisabled(),true);assert.equal(await page.locator('#capture-stop').isDisabled(),true);
      await page.evaluate(()=>{qa.status={phase:'recording',elapsed_ms:65000};qa.emit('capture-status',qa.status);});
      await click('Stop and save');await page.getByText('Recording finished',{exact:true}).waitFor();
    });
    await check('compact panel ignores stale status, survives reuse and fits both themes',async()=>{
      await page.evaluate(()=>{qa.holdControls=true;qa.emit('capture-controls-refresh');});
      await page.waitForFunction(()=>!!qa.releaseControls);
      await page.evaluate(()=>{qa.status={phase:'paused',elapsed_ms:123000};qa.emit('capture-status',qa.status);qa.holdControls=false;qa.releaseControls();});
      await page.getByText('Paused',{exact:true}).waitFor();assert.equal(await page.locator('#capture-time').innerText(),'02:03');
      for(const theme of ['Dark','Light'])for(const width of [480,360]){
        await page.setViewportSize({width,height:152});await page.evaluate(theme=>{qa.settings.appearance=theme;qa.status={phase:'recording',elapsed_ms:123000};qa.emit('capture-controls-refresh');},theme);
        await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme.toLowerCase(),theme);await noOverflow();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);await shot(`compact-${theme.toLowerCase()}-${width}`);
      }
      await page.evaluate(()=>document.documentElement.style.fontSize='28px');await noOverflow();await click('Expand');
      await page.evaluate(()=>{document.documentElement.style.fontSize='';qa.status={phase:'paused',elapsed_ms:123000,error:'Test: microphone disconnected. '+ 'VeryLongDeviceNameWithoutSpaces'.repeat(10)};qa.emit('capture-status',qa.status);});
      await noOverflow();await shot('compact-error');assert.equal(await page.locator('#capture-stop').isEnabled(),true);
      await page.evaluate(()=>{qa.fail='capture_controls_state';qa.emit('capture-controls-refresh');});await page.getByText('Reconnect',{exact:true}).waitFor();
      await click('Reconnect');await page.waitForFunction(()=>document.querySelector('#capture-retry').hidden);assert.deepEqual(errors,[]);
    });
    await check('compact shortcuts display Command on macOS',async()=>{
      await page.addInitScript(()=>{
        Object.defineProperty(navigator,'platform',{value:'MacIntel',configurable:true});
        qa.settings.stop_hotkey='Super+Shift+F10';qa.settings.pause_hotkey='Super+Shift+F11';
      });
      await page.goto('http://screen-recorder.test/capture.html');
      await page.getByText('Recording finished',{exact:true}).waitFor();
      assert.equal(await page.locator('#capture-pause').getAttribute('title'),'Pause / resume: Shift + ⌘ Cmd + F11');
      assert.equal(await page.locator('#capture-stop').getAttribute('title'),'Stop and save: Shift + ⌘ Cmd + F10');
    });
    await check('compact panel reconnects status events after initialization failure',async()=>{
      await page.addInitScript(()=>qa.failListen='capture-status');await page.goto('http://screen-recorder.test/capture.html');
      await page.getByText('Reconnect',{exact:true}).waitFor();assert.equal(await page.locator('#capture-pause').isDisabled(),true);
      await click('Reconnect');await page.getByText('Recording finished',{exact:true}).waitFor();
      await page.evaluate(()=>{qa.status={phase:'paused',elapsed_ms:32000};qa.emit('capture-status',qa.status);});
      await page.getByText('Paused',{exact:true}).waitFor();assert.equal(await page.locator('#capture-time').innerText(),'00:32');assert.deepEqual(errors,[]);
    });
    await check('startup failure shows an actionable retry and recovers',async()=>{
      await page.addInitScript(()=>{if(!sessionStorage.startupFailureChecked){qa.fail='bootstrap';qa.failListen=null;sessionStorage.startupFailureChecked='yes';}else qa.failListen=null;});
      await page.goto('http://screen-recorder.test/');
      await page.getByRole('heading',{name:'Could not start Screen Recorder',exact:true}).waitFor();
      assert.equal(await page.locator('#settings-nav').isDisabled(),true);
      await click('Retry');await page.getByRole('heading',{name:'Record your screen',exact:true}).waitFor();
      assert.equal(await page.locator('#app-version').innerText(),'v0.1.0');
      assert.match(await page.locator('#footer-hint').innerText(),/Ctrl \+ Shift \+ F9/);
    });
    await check('native system language selects Russian and live overrides persist without resetting settings',async()=>{
      await page.goto('http://screen-recorder.test/?system-language=ru-RU');
      await page.getByRole('heading',{name:'Запись экрана',exact:true}).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),'ru');
      assert.match(await page.getByLabel('Экран',{exact:true}).innerText(),/Экран 1/);
      await click('Настроить');assert.equal(await page.getByLabel('Язык',{exact:true}).inputValue(),'System');
      await page.getByLabel('Частота кадров',{exact:true}).selectOption('60');await page.getByLabel('Язык',{exact:true}).selectOption('English');
      await page.evaluate(()=>qa.holdSettings=true);await click('Сохранить настройки');await page.waitForFunction(()=>!!qa.releaseSettings);
      assert.equal(await page.getByLabel('Язык',{exact:true}).isDisabled(),true);
      assert.equal(await page.locator('#home-nav').isDisabled(),true);assert.equal(await page.evaluate(()=>qa.settings.language),'System');
      await page.evaluate(()=>{qa.holdSettings=false;qa.releaseSettings();});await page.getByText('Settings saved',{exact:true}).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.getByLabel('Frame rate',{exact:true}).inputValue(),'60');
      await page.getByText('Not registered for launch at login.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Save settings');
      assert.equal((await last('save_settings')).settings.language,'English');
      await page.getByLabel('Language',{exact:true}).selectOption('Russian');await page.evaluate(()=>qa.fail='save_settings');await click('Save settings');
      await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Test:'));
      assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.evaluate(()=>qa.settings.language),'English');
      await click('Save settings');await page.getByText('Настройки сохранены',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Частота кадров',{exact:true}).inputValue(),'60');
      await page.getByLabel('Язык',{exact:true}).selectOption('System');await click('Сохранить настройки');
      assert.equal(await page.locator('html').getAttribute('lang'),'ru');
    });
    await check('Russian editor localizes selection, crop, audio and export without translating filenames',async()=>{
      await page.evaluate(()=>qa.document.source='Settings.mp4');await click('Открыть видео');
      await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await page.getByRole('heading',{name:'Settings.mp4',exact:true}).waitFor();
      await selectRange(.5,1.5);assert.match(await page.locator('.timeline-selection-text').innerText(),/выделено 1 с/);
      await click('Удалить выделенное');await click('Сохранить проект');assert.deepEqual((await last('save_project')).project.keep,[{start_us:0,end_us:500000},{start_us:1500000,end_us:4000000}]);await click('Отменить');
      await page.locator('.edit-tool summary').filter({hasText:/^Звук$/}).click();
      await page.getByLabel('Громкость: Звук видео 1',{exact:true}).fill('-6');
      await page.locator('video').dblclick();await page.getByRole('heading',{name:'Кадрировать видео',exact:true}).waitFor();
      await page.getByRole('button',{name:'Весь кадр',exact:true}).click();await page.getByRole('button',{name:'Применить',exact:true}).click();
      await selectRange(.5,1.5);await click('Экспорт выделения');await page.getByText('Экспорт MP4…',{exact:true}).waitFor();
      assert.equal((await last('export_video')).project.audio[0].gain_db,-6);
      await page.evaluate(()=>qa.finishExport('C:/Videos/Settings.mp4'));await page.getByText('Выделенный отрезок экспортирован',{exact:true}).waitFor();
      assert.equal(await page.locator('.export-path').innerText(),'C:/Videos/Settings.mp4');
      for(const theme of ['dark','light'])for(const width of [1080,900,620,360]){await page.setViewportSize({width,height:748});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await noOverflow();}
      await shot('editor-russian');await page.setViewportSize({width:1080,height:920});
    });
    await check('explicit languages override the system and unsupported locales fall back to English',async()=>{
      for(const [query,heading,language] of [['system-language=ru-RU&preference=English','Record your screen','en'],['system-language=en-US&preference=Russian','Запись экрана','ru'],['system-language=pl-PL','Record your screen','en']]){
        await page.goto('http://screen-recorder.test/?'+query);await page.getByRole('heading',{name:heading,exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),language);
      }
    });
    await check('Russian compact controls and area selection use the same language preference',async()=>{
      await page.goto('http://screen-recorder.test/capture.html?system-language=ru-RU');
      await page.getByText('Запись завершена',{exact:true}).waitFor();
      await page.evaluate(()=>{qa.status={phase:'recording',elapsed_ms:5000};qa.emit('capture-status',qa.status);});
      await click('Пауза');await page.getByRole('button',{name:'Продолжить',exact:true}).waitFor();
      await page.evaluate(()=>{qa.settings.language='English';qa.emit('capture-controls-refresh');});
      await page.getByRole('button',{name:'Resume',exact:true}).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),'en');
      await page.goto('http://screen-recorder.test/?overlay=1&display=1&width=1920&height=1080&x=100&y=100&w=640&h=360&language=ru');
      await page.getByRole('button',{name:'Записать область',exact:true}).waitFor();
      await page.getByText('Точные координаты',{exact:true}).click();assert.equal(await page.getByLabel('Ширина',{exact:true}).inputValue(),'640');
      await click('Записать область');assert.equal((await last('apply_region')).startRecording,true);await noOverflow();assert.deepEqual(errors,[]);
    });
    await check('login status reads system registration, handles moved copies, read errors and retry',async()=>{
      await page.goto('http://screen-recorder.test/');await page.getByRole('heading',{name:'Record your screen',exact:true}).waitFor();
      await page.evaluate(()=>{qa.settings.autostart=true;qa.loginStatus={registered:false,current_executable:false};qa.holdLogin=true;});
      await click('Settings');await page.getByText('Checking launch-at-login registration…',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Launch at login',{exact:true}).isDisabled(),true);
      assert.equal(await page.getByRole('button',{name:'Save settings',exact:true}).isDisabled(),true);
      await page.evaluate(()=>{qa.holdLogin=false;qa.releaseLogin();});
      await page.getByText('Not registered for launch at login.',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Launch at login',{exact:true}).isChecked(),false);
      await page.evaluate(()=>qa.loginStatus={registered:true,current_executable:false});await click('Refresh login status');
      await page.getByText('The login entry points to another copy. Save settings to use this app.',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Launch at login',{exact:true}).isChecked(),true);await click('Save settings');
      await page.getByText('Registered for launch at login.',{exact:true}).waitFor();assert.equal((await last('save_settings')).settings.autostart,true);
      await page.evaluate(()=>qa.fail='login_status');await click('Refresh login status');await page.waitForFunction(()=>document.querySelector('#login-status').textContent.includes('Test:'));
      assert.equal(await page.getByLabel('Launch at login',{exact:true}).isDisabled(),false);
      await page.evaluate(()=>qa.loginStatus={registered:false,current_executable:false});await click('Refresh login status');await page.getByText('Not registered for launch at login.',{exact:true}).waitFor();
    });
    await check('closing to tray pauses preview, flushes edits once and preserves failed edits for retry',async()=>{
      await click('Open video');await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
      await selectRange(.5,1.5);await page.evaluate(()=>qa.holdSave=true);await click('Delete selection');await click('Play');await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
      const before=await page.evaluate(()=>qa.calls.filter(c=>c.command==='hide_main').length);
      await page.evaluate(()=>{qa.emit('close-request');qa.emit('close-request');});await page.waitForFunction(()=>!!qa.releaseSave);
      assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.command==='hide_main').length),before);
      await page.evaluate(()=>{qa.holdSave=false;qa.releaseSave();});await page.waitForFunction(before=>qa.calls.filter(c=>c.command==='hide_main').length===before+1,before);
      await selectRange(.3,.6,3);
      await page.evaluate(()=>{qa.fail='save_project';[...document.querySelectorAll('button')].find(b=>b.textContent==='Delete selection').click();qa.emit('close-request');});
      await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Test:'));
      assert.equal(await page.evaluate(()=>qa.calls.filter(c=>c.command==='hide_main').length),before+1);
      await page.evaluate(()=>qa.emit('close-request'));await page.waitForFunction(before=>qa.calls.filter(c=>c.command==='hide_main').length===before+2,before);
    });
    await check('tray Quit reveals a failed exit and a missing tray never discards the open editor',async()=>{
      await page.evaluate(()=>{qa.fail='quit';qa.emit('quit-request');});await page.waitForFunction(()=>qa.calls.some(c=>c.command==='show_main_window'));
      assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
      await page.evaluate(()=>{qa.fail='hide_main';qa.emit('close-request');});await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Test:'));
      assert.equal(await page.getByRole('button',{name:'Export MP4',exact:true}).isEnabled(),true);assert.deepEqual(errors,[]);
    });
    await fs.writeFile(path.join(output,'results.json'),JSON.stringify({checks,errors,scope:'Headless Chromium frontend with mocked Tauri commands; media decoded from supplied local MP4. Does not test native dialogs or capture.'},null,2));
  }catch(error){await shot('failure');console.error(JSON.stringify(await page.evaluate(()=>({calls:qa.calls.slice(-6),notice:document.querySelector('#notice')?.textContent})),null,2));throw error;}
  finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
