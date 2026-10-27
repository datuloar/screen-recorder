import { t } from './i18n.js';
import {fitRegion,dragRegion} from './model.js';

const make=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text)node.textContent=t(text);return node;};
const sides=[['nw','Top left corner'],['n','Top edge'],['ne','Top right corner'],['e','Right edge'],['se','Bottom right corner'],['s','Bottom edge'],['sw','Bottom left corner'],['w','Left edge']];

export class CropEditor {
  constructor({video,width,height,crop,onApply,onClose}) {
    Object.assign(this,{video,width,height,onApply,onClose});
    this.rect=crop?{...crop}:null;this.closed=false;
    this.parent=video.parentNode;this.next=video.nextSibling;this.videoStyle=video.getAttribute('style');
    this.dialog=make('dialog','crop-dialog');this.dialog.setAttribute('aria-labelledby','crop-title');
    const title=make('h2','','Crop video');title.id='crop-title';
    const hint=make('p','muted','Drag over the video to select what to keep. Move the frame or resize its edges.');hint.id='crop-help';
    this.stage=make('div','crop-stage');this.stage.style.aspectRatio=`${width}/${height}`;this.stage.style.width=`min(100%, calc(52dvh * ${width/height}))`;
    this.stage.tabIndex=0;this.stage.setAttribute('aria-label',t('Video crop'));this.stage.setAttribute('aria-describedby','crop-help');
    const layer=make('div','crop-video-layer');layer.append(video);this.stage.append(layer);
    Object.assign(video.style,{position:'absolute',width:'100%',height:'100%',left:'0',top:'0',objectFit:'fill'});
    this.shades=Array.from({length:4},()=>{const shade=make('div','crop-shade');this.stage.append(shade);return shade;});
    this.box=make('div','crop-box');this.box.tabIndex=0;this.box.setAttribute('role','group');this.box.setAttribute('aria-label',t('Crop frame. Arrow keys move the frame'));
    for(const [side,label] of sides){
      const handle=make('button',`crop-handle ${side}`);handle.type='button';handle.dataset.edge=side;handle.setAttribute('aria-label',t(label));handle.title=t(label);
      handle.addEventListener('keydown',event=>this.key(event,side));this.box.append(handle);
    }
    this.box.addEventListener('keydown',event=>{if(event.target===this.box)this.key(event,'move');});this.stage.append(this.box);
    this.status=make('output','crop-status');this.status.setAttribute('aria-live','polite');
    this.state=make('p','crop-state','Loading frame…');this.state.setAttribute('role','status');
    this.apply=this.button('Apply',()=>this.commit());this.apply.className='primary';
    const draw=this.button('Draw again',()=>{this.cancelDrag();this.rect=null;this.draw();this.stage.focus();});
    const whole=this.button('Full frame',()=>{this.cancelDrag();this.rect=fitRegion({x:0,y:0,width,height},width,height);this.draw();this.box.focus();});
    const cancel=this.button('Cancel',()=>this.close());
    const actions=make('div','crop-actions'),selection=make('div','row'),finish=make('div','row');selection.append(draw,whole);finish.append(cancel,this.apply);actions.append(selection,finish);
    const area=make('div','crop-area');area.append(this.stage);
    this.dialog.append(title,hint,area,this.state,this.status,actions,make('p','kbd-hint','Arrows: move 2 px · Shift: move 10 px · Enter: apply · Esc: cancel'));
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    this.dialog.addEventListener('keydown',event=>{
      event.stopPropagation();
      if(event.key==='Enter' && !event.target.closest('button')){event.preventDefault();this.commit();}
    });
    this.stage.addEventListener('pointerdown',event=>this.down(event));
    this.stage.addEventListener('pointermove',event=>this.move(event));
    this.stage.addEventListener('pointerup',event=>this.up(event));
    this.stage.addEventListener('pointercancel',()=>this.cancelDrag());
    this.stage.addEventListener('lostpointercapture',()=>this.cancelDrag());
    this.ready=()=>{this.available=video.readyState>=2 && !video.seeking;this.state.hidden=this.available;this.draw();};
    this.failed=()=>{this.available=false;this.state.hidden=false;this.state.textContent=t('Could not load the frame. Close this dialog and try another video.');this.draw();};
    video.addEventListener('loadeddata',this.ready);video.addEventListener('seeked',this.ready);video.addEventListener('error',this.failed);
    document.body.append(this.dialog);this.dialog.showModal();this.ready();this.stage.focus();
  }
  button(label,action){const button=make('button','',label);button.type='button';button.onclick=action;return button;}
  draw() {
    const r=this.rect;this.box.hidden=!r;this.shades.forEach(shade=>shade.hidden=!r);this.apply.disabled=!r || !this.available;
    this.status.textContent=r?t('{width} × {height} px · position {x}, {y}',r):t('Select the part of the video to keep');
    if(!r)return;
    const x=r.x/this.width*100,y=r.y/this.height*100,w=r.width/this.width*100,h=r.height/this.height*100;
    Object.assign(this.box.style,{left:`${x}%`,top:`${y}%`,width:`${w}%`,height:`${h}%`});
    const masks=[[0,0,100,y],[0,y+h,100,100-y-h],[0,y,x,h],[x+w,y,100-x-w,h]];
    masks.forEach(([left,top,width,height],index)=>Object.assign(this.shades[index].style,{left:`${left}%`,top:`${top}%`,width:`${Math.max(0,width)}%`,height:`${Math.max(0,height)}%`}));
    this.box.setAttribute('aria-description',this.status.textContent);
  }
  point(event){const bounds=this.stage.getBoundingClientRect();return {x:Math.max(0,Math.min(this.width,Math.round((event.clientX-bounds.left)/bounds.width*this.width))),y:Math.max(0,Math.min(this.height,Math.round((event.clientY-bounds.top)/bounds.height*this.height)))};}
  down(event) {
    if(event.button!==0 || !this.available || this.drag)return;
    event.preventDefault();const side=event.target.closest('[data-edge]')?.dataset.edge || (this.box.contains(event.target)?'move':'new');
    const previous=this.rect?{...this.rect}:null;
    this.drag={pointer:event.pointerId,side,start:this.point(event),previous,moved:false};
    (side==='new'?this.stage:event.target.closest('button')||this.box).focus({preventScroll:true});
    this.stage.setPointerCapture(event.pointerId);
  }
  move(event) {
    const drag=this.drag;if(!drag || drag.pointer!==event.pointerId)return;
    const point=this.point(event),dx=point.x-drag.start.x,dy=point.y-drag.start.y;
    if(!drag.moved && Math.abs(dx)<2 && Math.abs(dy)<2)return;
    drag.moved=true;
    this.rect=drag.side==='new'?fitRegion({x:Math.min(point.x,drag.start.x),y:Math.min(point.y,drag.start.y),width:Math.abs(dx),height:Math.abs(dy)},this.width,this.height):dragRegion(drag.previous,drag.side,dx,dy,this.width,this.height);
    this.draw();
  }
  up(event){if(!this.drag || this.drag.pointer!==event.pointerId)return;this.move(event);this.drag=null;if(this.stage.hasPointerCapture(event.pointerId))this.stage.releasePointerCapture(event.pointerId);}
  cancelDrag(){if(!this.drag)return;const drag=this.drag;this.drag=null;this.rect=drag.previous;this.draw();if(this.stage.hasPointerCapture(drag.pointer))this.stage.releasePointerCapture(drag.pointer);}
  key(event,side){
    if(!this.rect || !event.key.startsWith('Arrow'))return;
    event.preventDefault();event.stopPropagation();const step=event.shiftKey?10:2;
    const dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
    this.rect=dragRegion(this.rect,side,dx,dy,this.width,this.height);this.draw();
  }
  commit(){
    if(!this.rect || !this.available || this.closed)return;
    const crop={...this.rect};this.close();
    this.onApply(crop.x===0 && crop.y===0 && crop.width===this.width && crop.height===this.height?null:crop);
  }
  close(){
    if(this.closed)return;this.closed=true;this.cancelDrag();
    this.video.removeEventListener('loadeddata',this.ready);this.video.removeEventListener('seeked',this.ready);this.video.removeEventListener('error',this.failed);
    this.parent.insertBefore(this.video,this.next?.parentNode===this.parent?this.next:null);
    if(this.videoStyle===null)this.video.removeAttribute('style');else this.video.setAttribute('style',this.videoStyle);
    this.dialog.close();this.dialog.remove();this.onClose();
  }
}
