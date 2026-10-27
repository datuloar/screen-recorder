import {duration,seconds,snapTime,nearestPoint} from './model.js';
import {Filmstrip} from './filmstrip.js';

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export class Timeline {
  constructor({fps,source,onSeek,onEdit,onSplit,onError,onPause,onPreview,onExport}) {
    Object.assign(this,{fps,onSeek,onEdit,onSplit,onError,onPause,onPreview,onExport});
    this.zoom = 1; this.selection = null; this.at = 0; this.busy = false;
    this.snapping=true;
    this.filmstrip=new Filmstrip(source);
    this.element = element('section','timeline-editor');
    this.element.setAttribute('aria-label','Timeline');
    const header = element('div','timeline-heading');
    header.append(element('h2','','Timeline'));
    this.zoomInput = document.createElement('input');
    Object.assign(this.zoomInput,{type:'range',min:1,max:16,step:0.5,value:1});
    this.zoomInput.setAttribute('aria-label','Timeline zoom');
    this.zoomText = element('output','','100%');
    this.zoomInput.oninput = () => this.setZoom(Number(this.zoomInput.value));
    const zoom = element('div','timeline-zoom');
    this.zoomSelectionButton=this.action('Zoom to selection',()=>this.zoomSelection());
    this.zoomSelectionButton.textContent='Selection';this.zoomSelectionButton.setAttribute('aria-label','Zoom to selection');
    zoom.append(this.action('Fit',()=>this.setZoom(1)),this.zoomSelectionButton,this.zoomInput,this.zoomText);header.append(zoom);
    this.toolbar = element('div','timeline-actions');
    this.splitButton = this.action('Split at playhead',()=>onSplit(this.at));
    this.deleteButton = this.action('Delete selection',()=>this.edit(false));
    this.keepButton = this.action('Keep selection',()=>this.edit(true));
    this.clearButton = this.action('Clear selection',()=>this.select(null));
    this.snapButton=this.action('Snap',()=>{this.snapping=!this.snapping;this.snapButton.setAttribute('aria-pressed',String(this.snapping));});
    this.snapButton.setAttribute('aria-pressed','true');this.snapButton.title='Snap selection edges to cuts and the playhead. Hold Alt to disable temporarily.';
    this.toolbar.append(this.splitButton,this.deleteButton,this.keepButton,this.snapButton);
    this.scroller = element('div','timeline-scroll');
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('aria-label','Video timeline. Click the ruler to seek. Drag across the track to select.');
    this.canvas = element('div','timeline-canvas');
    this.ruler = element('div','timeline-ruler');
    this.track = element('div','timeline-track');
    this.track.setAttribute('aria-label','Video clips');
    this.range = element('div','timeline-range');this.range.hidden = true;
    this.handles = ['start','end'].map(side=>{
      const handle = element('div',`timeline-handle ${side}`);
      handle.tabIndex = 0;handle.setAttribute('role','slider');handle.dataset.edge=side;
      handle.setAttribute('aria-label',side==='start'?'Selection start':'Selection end');
      handle.addEventListener('keydown',event=>this.handleKey(event,side));
      this.range.append(handle);return handle;
    });
    this.playhead = element('div','timeline-playhead');this.playhead.setAttribute('aria-hidden','true');
    this.snapGuide=element('div','timeline-snap-guide');this.snapGuide.hidden=true;this.snapGuide.setAttribute('aria-hidden','true');this.snapGuide.append(element('span'));
    this.canvas.append(this.ruler,this.track,this.range,this.playhead,this.snapGuide);this.scroller.append(this.canvas);
    const selectionRow = element('div','timeline-selection-summary');
    this.previewButton=this.action('Preview selection',()=>this.onPreview({...this.selection}));
    this.exportButton=this.action('Export selection',()=>this.onExport({...this.selection}));this.exportButton.title='Export the selection to a separate MP4 without changing your edit';
    this.selectionText=element('output','timeline-selection-text');this.selectionText.setAttribute('aria-live','polite');selectionRow.append(this.selectionText);
    const selectionActions=element('div','timeline-selection-actions');selectionActions.append(this.previewButton,this.exportButton,this.clearButton);selectionRow.append(selectionActions);
    this.element.append(header,this.toolbar,this.scroller,selectionRow,element('p','kbd-hint','Drag across clips, then adjust the edges. Alt: disable snap. Ctrl + wheel: zoom. Right-click: edit menu.'));
    this.canvas.addEventListener('pointerdown',event=>this.pointerDown(event));
    this.canvas.addEventListener('pointermove',event=>this.pointerMove(event));
    this.canvas.addEventListener('pointerup',event=>this.pointerUp(event));
    this.canvas.addEventListener('pointercancel',()=>this.cancelDrag());
    this.canvas.addEventListener('lostpointercapture',()=>{if(this.drag)this.cancelDrag();});
    this.scroller.addEventListener('wheel',event=>{
      if(this.busy || !(event.ctrlKey || event.metaKey))return;
      event.preventDefault();const before=this.timeAt(event.clientX),bounds=this.canvas.getBoundingClientRect();
      const offset=event.clientX-bounds.left-this.scroller.scrollLeft;
      this.setZoom(Math.max(1,Math.min(16,this.zoom+(event.deltaY<0?0.5:-0.5))));
      this.scroller.scrollLeft=before/this.total*this.canvas.clientWidth-offset;
    },{passive:false});
    this.scroller.addEventListener('contextmenu',event=>{
      event.preventDefault();if(this.busy)return;this.onPause();
      const at=this.timeAt(event.clientX),clip=event.target.closest('.timeline-clip');
      if(clip && (!this.selection || at<this.selection.start || at>this.selection.end))this.select({start:Number(clip.dataset.start),end:Number(clip.dataset.end)});
      this.onSeek(at);this.openMenu(event.clientX,event.clientY);
    });
    this.scroller.addEventListener('keydown',event=>{
      if(event.key==='ContextMenu' || (event.shiftKey && event.key==='F10')){
        event.preventDefault();event.stopPropagation();const bounds=this.scroller.getBoundingClientRect();this.openMenu(bounds.left+30,bounds.top+20);
      }
    });
    this.observer=new ResizeObserver(()=>this.drawRuler());this.observer.observe(this.scroller);
  }
  safe(action) { try { action(); } catch(error) { this.onError(String(error)); } }
  action(label,callback) {const button=element('button','',label);button.type='button';button.onclick=()=>{if(!this.busy)this.safe(callback);};return button;}
  update(project,{clear=false}={}) {
    this.project=project;this.total=duration(project);this.cancelDrag();
    this.cutPoints=[{at:0,label:'Start'}];let cut=0;
    for(const range of project.keep){cut+=range.end_us-range.start_us;this.cutPoints.push({at:cut,label:cut===this.total?'End':'Cut'});}
    if(clear)this.selection=null;
    this.track.replaceChildren();let offset=0;const frames=[];
    project.keep.forEach((range,index)=>{
      const length=range.end_us-range.start_us,at=offset;
      const clip=this.action(`Clip ${index+1}`,()=>{this.onPause();this.select({start:at,end:at+length});this.onSeek(at);});
      clip.className='timeline-clip';clip.dataset.index=index;
      clip.dataset.start=at;clip.dataset.end=at+length;
      clip.setAttribute('aria-label',`Clip ${index+1}, source ${seconds(range.start_us)} to ${seconds(range.end_us)} seconds`);
      clip.title=clip.getAttribute('aria-label');
      const strip=element('span','clip-filmstrip');strip.setAttribute('aria-hidden','true');
      const caption=element('span','clip-caption',`Clip ${index+1}`);caption.append(element('small','',`${seconds(range.start_us)}…${seconds(range.end_us)} s`));clip.replaceChildren(strip,caption);
      frames.push({element:strip,start:range.start_us,end:range.end_us});
      Object.assign(clip.style,{left:`${at/this.total*100}%`,width:`${length/this.total*100}%`});
      clip.addEventListener('click',event=>{if(event.detail>0){event.preventDefault();event.stopImmediatePropagation();}},true);
      this.track.append(clip);offset+=length;
    });
    this.drawRuler();this.drawSelection();this.position(this.at);
    this.filmstrip.update(frames);
  }
  position(at) {this.at=Math.max(0,Math.min(this.total||0,at));this.playhead.style.left=`${this.total?this.at/this.total*100:0}%`;this.splitButton.disabled=this.busy || !this.at || this.at>=this.total;}
  select(selection) {
    this.selection=selection;this.drawSelection();
  }
  drawSelection() {
    const s=this.selection;
    this.range.hidden=!s;
    if(s){
      Object.assign(this.range.style,{left:`${s.start/this.total*100}%`,width:`${(s.end-s.start)/this.total*100}%`});
      this.handles.forEach((handle,index)=>{
        handle.setAttribute('aria-disabled',String(this.busy));handle.tabIndex=this.busy?-1:0;
        handle.setAttribute('aria-valuemin','0');handle.setAttribute('aria-valuemax',String(this.total/1e6));
        handle.setAttribute('aria-valuenow',String((index?s.end:s.start)/1e6));handle.setAttribute('aria-valuetext',`${seconds(index?s.end:s.start)} seconds`);
      });
    }
    this.selectionText.textContent=s?`${seconds(s.start)}…${seconds(s.end)} s · ${seconds(s.end-s.start)} s selected`:'Drag to select a range';
    this.previewButton.disabled=this.exportButton.disabled=this.zoomSelectionButton.disabled=this.busy || !s;
    this.deleteButton.disabled=this.busy || !s || s.end-s.start>=this.total;
    this.keepButton.disabled=this.busy || !s;
    this.clearButton.disabled=this.busy || !s;
    this.track.querySelectorAll('.timeline-clip').forEach(clip=>{
      const start=Number(clip.dataset.start),end=Number(clip.dataset.end);
      clip.setAttribute('aria-pressed',String(!!s && s.start<=start && s.end>=end));
    });
  }
  edit(retain) {
    if(this.busy || !this.selection)return;
    const {start,end}=this.selection;
    this.onPause();this.onEdit(start,end,retain);
  }
  setBusy(value) {this.busy=value;this.cancelDrag();this.element.querySelectorAll('button,input').forEach(node=>node.disabled=value);this.drawSelection();this.position(this.at);}
  setZoom(value) {
    const anchor=this.total?this.at/this.total:0;
    this.zoom=value;this.zoomInput.value=value;this.zoomText.textContent=`${Math.round(value*100)}%`;
    this.canvas.style.width=`${value*100}%`;this.drawRuler();this.scroller.scrollLeft=Math.max(0,anchor*this.canvas.clientWidth-this.scroller.clientWidth/2);
  }
  zoomSelection() {
    if(!this.selection || this.busy)return;
    this.setZoom(Math.max(1,Math.min(16,this.total/(this.selection.end-this.selection.start)*0.8)));
    this.scroller.scrollLeft=Math.max(0,this.selection.start/this.total*this.canvas.clientWidth-this.scroller.clientWidth*0.1);
  }
  mark(side) {
    if(this.busy)return;this.onPause();const frame=Math.min(Math.round(1e6/this.fps),this.total);
    const at=snapTime(this.at,this.fps,this.total),s=this.selection?{...this.selection}:{start:0,end:this.total};
    if(side==='start'){s.start=Math.min(at,this.total-frame);if(s.end<=s.start)s.end=Math.min(this.total,s.start+frame);}
    else {s.end=Math.min(this.total,at+frame);if(s.start>=s.end)s.start=Math.max(0,s.end-frame);}
    this.select(s);
  }
  jumpCut(direction) {
    if(this.busy)return;this.onPause();const points=[0];let at=0;
    for(const range of this.project.keep){at+=range.end_us-range.start_us;points.push(at);}
    const next=direction<0?points.findLast(point=>point<this.at-1):points.find(point=>point>this.at+1);
    this.onSeek(next??(direction<0?0:this.total));
  }
  openMenu(x,y) {
    if(this.busy)return;this.closeMenu();
    const menu=element('dialog','timeline-menu');menu.setAttribute('aria-label','Edit menu');
    const entries=[['Split at playhead','S',()=>this.onSplit(this.at),this.splitButton.disabled],['Delete selection','Delete',()=>this.edit(false),this.deleteButton.disabled],['Keep selection','',()=>this.edit(true),this.keepButton.disabled],['Preview selection','',()=>this.onPreview({...this.selection}),!this.selection],['Export selection','',()=>this.onExport({...this.selection}),!this.selection],['Zoom to selection','',()=>this.zoomSelection(),!this.selection],['Set selection start','I',()=>this.mark('start')],['Set selection end','O',()=>this.mark('end')],['Clear selection','Esc',()=>this.select(null),!this.selection]];
    for(const [label,key,action,disabled] of entries){const item=this.action(label,()=>{this.closeMenu();action();});item.disabled=!!disabled;item.append(element('kbd','',key));menu.append(item);}
    menu.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();this.closeMenu();});
    menu.addEventListener('keydown',event=>{
      event.stopPropagation();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    });
    menu.addEventListener('pointerdown',event=>{if(event.target===menu){const b=menu.getBoundingClientRect();if(event.clientX<b.left || event.clientX>b.right || event.clientY<b.top || event.clientY>b.bottom)this.closeMenu();}});
    document.body.append(menu);this.menu=menu;menu.showModal();
    menu.style.left=`${Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))}px`;
  }
  closeMenu() {if(this.menu){this.menu.close();this.menu.remove();this.menu=null;this.scroller.focus({preventScroll:true});}}
  drawRuler() {
    if(!this.total)return;
    const width=this.canvas.clientWidth||600,target=this.total/1e6/Math.max(1,width/100);
    const magnitude=10**Math.floor(Math.log10(Math.max(target,1/this.fps)));
    const step=[1,2,5,10].map(x=>x*magnitude).find(x=>x>=target)||10*magnitude;
    this.ruler.replaceChildren();
    for(let secondsAt=0;secondsAt<this.total/1e6;secondsAt+=step){
      const tick=element('span','timeline-tick',`${Number(secondsAt.toFixed(3))} s`);tick.style.left=`${secondsAt*1e6/this.total*100}%`;this.ruler.append(tick);
    }
  }
  timeAt(clientX) {const bounds=this.canvas.getBoundingClientRect();return snapTime((clientX-bounds.left)/bounds.width*this.total,this.fps,this.total);}
  snapAt(clientX,min=0,max=this.total) {
    const bounds=this.canvas.getBoundingClientRect(),raw=(clientX-bounds.left)/bounds.width*this.total;
    const point=this.snapping && !this.drag?.alt?nearestPoint(raw,this.drag?.points||this.cutPoints,8/bounds.width*this.total,min,max):null;
    this.snapGuide.hidden=!point;
    if(point){this.snapGuide.style.left=`${point.at/this.total*100}%`;this.snapGuide.classList.toggle('at-end',point.at>this.total*0.8);this.snapGuide.firstChild.textContent=point.label;}
    return point?.at??Math.max(min,Math.min(max,snapTime(raw,this.fps,this.total)));
  }
  pointerDown(event) {
    if(this.busy || event.button!==0)return;
    event.preventDefault();this.onPause();
    const edge=event.target.closest('[data-edge]')?.dataset.edge;
    const ruler=this.ruler.contains(event.target);
    this.scroller.focus({preventScroll:true});
    this.drag={pointer:event.pointerId,x:event.clientX,origin:event.clientX,anchor:this.timeAt(event.clientX),previous:this.selection?{...this.selection}:null,edge,mode:ruler?'seek':'select',clip:event.target.closest('.timeline-clip')?.dataset.index,moved:false,alt:event.altKey,points:[...this.cutPoints,{at:snapTime(this.at,this.fps,this.total),label:'Playhead'}]};
    if(!ruler && !edge)this.drag.anchor=this.snapAt(event.clientX);
    this.canvas.setPointerCapture(event.pointerId);
    if(ruler)this.onSeek(this.drag.anchor);
    const autoScroll=()=>{
      if(!this.drag)return;
      const bounds=this.scroller.getBoundingClientRect(),x=this.drag.x;
      const delta=x<bounds.left+24?-12:x>bounds.right-24?12:0;
      if(delta && this.drag.moved){this.scroller.scrollLeft+=delta;this.moveDrag();}
      this.scrollFrame=requestAnimationFrame(autoScroll);
    };this.scrollFrame=requestAnimationFrame(autoScroll);
  }
  pointerMove(event) {if(!this.drag || this.drag.pointer!==event.pointerId)return;this.drag.x=event.clientX;this.drag.alt=event.altKey;this.drag.moved ||= Math.abs(event.clientX-this.drag.origin)>3;if(this.drag.moved)this.moveDrag();}
  moveDrag() {
    const drag=this.drag,minimum=Math.min(Math.round(1e6/this.fps),this.total);
    if(drag.mode==='seek'){this.onSeek(this.timeAt(drag.x));return;}
    const min=drag.edge==='end' && drag.previous?drag.previous.start+minimum:0,max=drag.edge==='start' && drag.previous?drag.previous.end-minimum:this.total;
    const at=this.snapAt(drag.x,min,max);
    let selection;
    if(drag.edge && drag.previous){
      selection={...drag.previous};
      if(drag.edge==='start')selection.start=Math.max(0,Math.min(at,selection.end-minimum));
      else selection.end=Math.min(this.total,Math.max(at,selection.start+minimum));
    }else{
      const start=Math.min(at,drag.anchor),end=Math.max(at,drag.anchor);
      selection=end>start?{start,end}:null;
    }
    this.select(selection);if(selection)this.onSeek(Math.min(at,selection.end-1e6/this.fps));
  }
  pointerUp(event) {
    const drag=this.drag;if(!drag || drag.pointer!==event.pointerId)return;
    if(!drag.moved && drag.mode==='select' && !drag.edge){
      if(drag.clip!==undefined){const index=Number(drag.clip);let start=0;for(let i=0;i<index;i++)start+=this.project.keep[i].end_us-this.project.keep[i].start_us;this.select({start,end:start+this.project.keep[index].end_us-this.project.keep[index].start_us});}
      else this.select(null);
      this.onSeek(drag.anchor);
    }
    this.drag=null;this.snapGuide.hidden=true;cancelAnimationFrame(this.scrollFrame);this.canvas.releasePointerCapture(event.pointerId);
  }
  cancelDrag() {this.snapGuide.hidden=true;if(!this.drag)return;const drag=this.drag;this.drag=null;cancelAnimationFrame(this.scrollFrame);this.select(drag.previous);if(this.canvas.hasPointerCapture(drag.pointer))this.canvas.releasePointerCapture(drag.pointer);}
  handleKey(event,side) {
    if(this.busy || !this.selection || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();this.onPause();
    const frame=Math.round(1e6/this.fps),s={...this.selection};
    let at=s[side]+(event.key==='ArrowLeft'?-1:1)*frame*(event.shiftKey?10:1);
    if(event.key==='Home')at=0;if(event.key==='End')at=this.total;
    s[side]=side==='start'?Math.max(0,Math.min(at,s.end-frame)):Math.min(this.total,Math.max(at,s.start+frame));
    this.select(s);this.onSeek(side==='start'?s.start:Math.max(s.start,s.end-frame));
  }
  destroy() {this.closeMenu();this.cancelDrag();this.observer.disconnect();cancelAnimationFrame(this.scrollFrame);this.filmstrip.destroy();}
}
