import * as THREE from 'three';

export type Hinge={id:number;name:string;parent:number;child:number;axis:number[];d:number[];hinge?:number[];allowance?:number;k_factor?:number|null;coordinate:number;dim:number;low:number;high:number;angle:number|null;source:{profile:string;vertex?:number|null}[];folded_lines?:{face:number;surface:number;points:number[][]}[]};
export type Drawing={mode?:string;thickness:number;radius:number;allowance:number;k_factor:number;faces:{id:number;polygons:{outer:number[][];holes:number[][][]}[]}[];bends:Hinge[]};
export const vector=(p:number[])=>new THREE.Vector3(p[0],p[1],p[2]);
export const hingePoint=(e:Hinge)=>e.hinge?vector(e.hinge):new THREE.Vector3().setComponent(1-e.dim,e.coordinate);
export const effectiveFraction=(data:Drawing,fraction:number)=>data.mode==='flat_review'||data.bends.some(e=>e.angle==null)?0:fraction;
export function hingeTransforms(data:Drawing,fraction:number){
 const f=effectiveFraction(data,fraction),transforms=new Map<number,THREE.Matrix4>(),byChild=new Map(data.bends.map(e=>[e.child,e]));
 function world(id:number):THREE.Matrix4{
  const cached=transforms.get(id);if(cached)return cached;
  const e=byChild.get(id);if(!e){const root=new THREE.Matrix4();transforms.set(id,root);return root;}
  const parent=world(e.parent);
  if(f<.00001||e.angle==null){transforms.set(id,parent.clone());return transforms.get(id)!;}
  const angle=THREE.MathUtils.degToRad(e.angle)*f,axis=vector(e.axis),d=vector(e.d),h=hingePoint(e),allowance=e.allowance??data.allowance;
  const R=new THREE.Matrix4().makeRotationAxis(axis,angle),rm=allowance/Math.abs(angle)+(0.5-(e.k_factor??data.k_factor))*data.thickness;
  const w=new THREE.Vector3().crossVectors(axis,d).multiplyScalar(Math.sign(angle));
  const center=h.clone().addScaledVector(d,-allowance/2).addScaledVector(w,rm);
  const end=center.clone().addScaledVector(w.clone().applyMatrix4(R),-rm);
  R.setPosition(end.sub(h.clone().addScaledVector(d,allowance/2).applyMatrix4(R)));
  const result=parent.clone().multiply(R);transforms.set(id,result);return result;
 }
 for(const face of data.faces)world(face.id);
 return transforms;
}

/** Tangent creases on both sheet surfaces; never mesh edges or solid material. */
export function bendSegments(data:Drawing,e:Hinge,fraction:number,frames=hingeTransforms(data,fraction)){
 const f=effectiveFraction(data,fraction);
 if(f>=.99999&&e.folded_lines)return e.folded_lines.map(l=>l.points.map(vector));
 const allowance=e.angle==null?0:(e.allowance??data.allowance);
 const sides=f<.00001?[[e.parent,0]]:[[e.parent,-allowance/2],[e.child,allowance/2]];
 return sides.flatMap(([face,offset])=>[-1,1].map(side=>[e.low,e.high].map(x=>
  hingePoint(e).addScaledVector(vector(e.d),offset).addScaledVector(vector(e.axis),x)
   .add(new THREE.Vector3(0,0,side*data.thickness/2)).applyMatrix4(frames.get(face)!))));
}

export function bendLabel(e:Hinge){
 const angle=e.angle==null?'UNKNOWN · needs review':`${e.angle>=0?'+':''}${e.angle.toFixed(3)}° rotation · ${(180-Math.abs(e.angle)).toFixed(3)}° included`;
 return `${e.name} · ${angle} · ${e.source.map(s=>s.profile+(s.vertex?` / vertex ${s.vertex}`:'')).join(', ')}`;
}

export function createBendOverlay(data:Drawing,panelId:string,scale=.001){
 const group=new THREE.Group();group.name='FlatForge_bend_axes';group.scale.setScalar(scale);
 const lines=data.bends.map(e=>{
  const material=new THREE.LineDashedMaterial({color:e.angle==null?0xe38a18:0x075fa3,dashSize:8,gapSize:5,depthTest:false,depthWrite:false,transparent:true,opacity:.85});
  const line=new THREE.LineSegments(new THREE.BufferGeometry(),material);line.name=`hinge_overlay_${e.id}`;
  line.userData={hinge:e,panelId,bendOverlay:true};line.renderOrder=20;group.add(line);return {line,e};
 });
 function update(fraction:number){const frames=hingeTransforms(data,fraction);for(const {line,e} of lines){
  line.geometry.dispose();line.geometry=new THREE.BufferGeometry().setFromPoints(bendSegments(data,e,fraction,frames).flat());line.computeLineDistances();
 }}
 function dispose(){for(const {line} of lines){line.geometry.dispose();line.material.dispose();}}
 update(1);return {group,update,dispose};
}
