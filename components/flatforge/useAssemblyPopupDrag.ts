'use client';
import {useEffect,type RefObject} from 'react';

/** Pointer capture keeps header drags separate from orbit/gizmo input. Positions
 * are session-only UI preferences, never assembly or CAD data. */
export function useAssemblyPopupDrag(workspace:RefObject<HTMLElement|null>,projectId:string){
 useEffect(()=>{
  const root=workspace.current,viewer=root?.querySelector<HTMLElement>('.viewer-stage');if(!root||!viewer)return;
  const cleanups=new Map<HTMLElement,()=>void>(),attached=new WeakSet<HTMLElement>();
  function attach(){
   for(const [panel,cleanup] of cleanups)if(!viewer!.contains(panel)){cleanup();cleanups.delete(panel);}
   for(const panel of viewer!.querySelectorAll<HTMLElement>('.asm-context,.asm-panel-list')){
    if(attached.has(panel))continue;const header=panel.querySelector<HTMLElement>('header');if(!header)continue;attached.add(panel);
    const key=`flatforge.popup.v1:${projectId}:${panel.getAttribute('aria-label')}`;
    const read=()=>{try{const p=JSON.parse(sessionStorage.getItem(key)||'null');return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)?p:null;}catch{return null;}};
    let position:{x:number;y:number}|null=read(),drag:{id:number;x:number;y:number;left:number;top:number}|null=null;
    const clamp=(x:number,y:number)=>({x:Math.max(6,Math.min(Math.max(6,viewer!.clientWidth-panel.offsetWidth-6),x)),y:Math.max(6,Math.min(Math.max(6,viewer!.clientHeight-panel.offsetHeight-6),y))});
    function apply(){if(!position)return;position=clamp(position.x,position.y);panel.style.left=position.x+'px';panel.style.top=position.y+'px';panel.style.right='auto';}
    function persist(){try{if(position)sessionStorage.setItem(key,JSON.stringify(position));else sessionStorage.removeItem(key);}catch{/* Session storage is optional. */}}
    const reset=document.createElement('button');reset.type='button';reset.className='asm-popup-reset';reset.textContent='↺';reset.setAttribute('aria-label','Reset popup position');reset.title='Reset popup position';
    reset.onclick=()=>{position=null;panel.style.removeProperty('left');panel.style.removeProperty('top');panel.style.removeProperty('right');persist();};header.appendChild(reset);
    header.classList.add('asm-draggable-header');header.title='Drag to reposition';
    const down=(event:PointerEvent)=>{if(event.button!==0||(event.target as Element).closest('button,input,select,textarea,a'))return;event.preventDefault();event.stopPropagation();const box=panel.getBoundingClientRect(),parent=viewer!.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left-parent.left,top:box.top-parent.top};header.setPointerCapture(event.pointerId);};
    const move=(event:PointerEvent)=>{if(!drag||drag.id!==event.pointerId)return;event.preventDefault();event.stopPropagation();position=clamp(drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y);apply();};
    const end=(event:PointerEvent)=>{if(!drag||drag.id!==event.pointerId)return;event.stopPropagation();drag=null;if(header.hasPointerCapture(event.pointerId))header.releasePointerCapture(event.pointerId);persist();};
    header.addEventListener('pointerdown',down);header.addEventListener('pointermove',move);header.addEventListener('pointerup',end);header.addEventListener('pointercancel',end);
    const resize=new ResizeObserver(apply);resize.observe(viewer!);resize.observe(panel);apply();
    cleanups.set(panel,()=>{resize.disconnect();header.removeEventListener('pointerdown',down);header.removeEventListener('pointermove',move);header.removeEventListener('pointerup',end);header.removeEventListener('pointercancel',end);reset.remove();});
   }
  }
  const observer=new MutationObserver(attach);observer.observe(viewer,{childList:true,subtree:true});attach();
  return()=>{observer.disconnect();cleanups.forEach(clean=>clean());};
 },[workspace,projectId]);
}
