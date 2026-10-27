import * as THREE from 'three';
import type { AssemblyEntry } from './types';
import { alphabeticLabel } from './assembly-workspace-state';

/** Lightweight HTML labels are screen-sized and remain outside export groups. */
export function createAssemblyLabels(options:{host:HTMLElement;camera:THREE.Camera;groups:Map<string,{group:THREE.Group;localBounds:THREE.Box3}>;
  entries:()=>AssemblyEntry[];active:()=>string|null;onSelect:(id:string)=>void}) {
  const layer=document.createElement('div');layer.className='asm-model-labels';options.host.appendChild(layer);
  const labels=new Map<string,HTMLButtonElement>();
  for(const entry of options.entries()){
    const button=document.createElement('button');button.type='button';button.className='asm-model-label';button.dataset.panelId=entry.id;
    button.onclick=()=>options.onSelect(entry.id);layer.appendChild(button);labels.set(entry.id,button);
  }
  const corners=Array.from({length:8},()=>new THREE.Vector3());
  function update(){
    const width=options.host.clientWidth,height=options.host.clientHeight,occupied:{x:number;y:number}[]=[];
    const entries=options.entries(),active=options.active();
    for(const entry of [...entries].sort((a,b)=>Number(b.id===active)-Number(a.id===active))){
      const button=labels.get(entry.id),item=options.groups.get(entry.id);if(!button||!item)continue;
      const label=`Panel ${entry.label??alphabeticLabel(entries.findIndex(e=>e.id===entry.id))}`;
      if(button.textContent!==label){button.textContent=label;button.setAttribute('aria-label',`Select ${label}`);}
      if(button.getAttribute('aria-pressed')!==String(entry.id===active))button.setAttribute('aria-pressed',String(entry.id===active));
      const box=item.localBounds;let minY=Infinity,minX=Infinity,maxX=-Infinity;let visible=false;
      for(let i=0;i<8;i++){
        const p=corners[i].set(i&1?box.max.x:box.min.x,i&2?box.max.y:box.min.y,i&4?box.max.z:box.min.z).applyMatrix4(item.group.matrixWorld).project(options.camera);
        if(p.z>=-1&&p.z<=1)visible=true;
        minY=Math.min(minY,(1-p.y)*height/2);minX=Math.min(minX,(p.x+1)*width/2);maxX=Math.max(maxX,(p.x+1)*width/2);
      }
      if(!item.group.visible||!visible||maxX<0||minX>width||minY>height){button.hidden=true;continue;}
      button.hidden=false;const x=Math.max(48,Math.min(width-48,(minX+maxX)/2));let y=Math.max(65,Math.min(height-85,minY-18));
      while(occupied.some(p=>Math.abs(p.x-x)<86&&Math.abs(p.y-y)<25)&&y<height-100)y+=26;
      occupied.push({x,y});button.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;
    }
  }
  return {update,dispose:()=>layer.remove()};
}
