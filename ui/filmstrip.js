export class Filmstrip {
  constructor(source) {
    this.video=document.createElement('video');this.video.muted=true;this.video.preload='auto';this.video.crossOrigin='anonymous';this.video.src=source;
    this.cache=new Map();this.version=0;this.closed=false;
  }
  update(clips) {
    this.clips=clips;this.version++;
    if(!this.running)this.run();
  }
  async waitFor(event,action) {
    await new Promise((resolve,reject)=>{
      const clean=()=>{clearTimeout(timer);this.video.removeEventListener(event,done);this.video.removeEventListener('error',fail);};
      const done=()=>{clean();resolve();},fail=()=>{clean();reject(Error('Preview frame unavailable'));};
      const timer=setTimeout(fail,5000);this.video.addEventListener(event,done,{once:true});this.video.addEventListener('error',fail,{once:true});
      try{action?.();}catch(error){clean();reject(error);}
    });
  }
  async run() {
    this.running=true;const version=this.version;
    try{
      if(this.video.readyState<2)await this.waitFor('loadeddata');
      const scale=Math.min(160/this.video.videoWidth,90/this.video.videoHeight);
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(this.video.videoWidth*scale));canvas.height=Math.max(1,Math.round(this.video.videoHeight*scale));
      const context=canvas.getContext('2d');let budget=24;
      for(const {element,start,end} of this.clips){
        if(this.closed || version!==this.version || !budget)break;
        const count=Math.min(budget,8,Math.max(1,Math.ceil(element.clientWidth/160)));budget-=count;
        for(let index=0;index<count;index++){
          if(this.closed || version!==this.version)break;
          const time=Math.round(start+(end-start)*(index+.5)/count)/1e6;
          let url=this.cache.get(time);
          if(!url){
            if(Math.abs(this.video.currentTime-time)>.00001 || this.video.readyState<2)await this.waitFor('seeked',()=>{this.video.currentTime=time;});
            if(this.closed || version!==this.version)break;
            context.drawImage(this.video,0,0,canvas.width,canvas.height);url=canvas.toDataURL('image/jpeg',.65);
            if(this.cache.size>=48)this.cache.delete(this.cache.keys().next().value);this.cache.set(time,url);
          }
          const image=document.createElement('img');image.src=url;image.alt='';image.draggable=false;image.style.width=`${100/count}%`;element.append(image);
        }
      }
    }catch{ /* The timeline stays usable when the system cannot decode preview frames. */ }
    finally{this.running=false;if(!this.closed && version!==this.version)this.run();}
  }
  destroy(){this.closed=true;this.version++;this.cache.clear();this.video.removeAttribute('src');this.video.load();}
}
