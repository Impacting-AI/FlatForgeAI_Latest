import * as THREE from 'three';
/** CPU preview for browsers without WebGL. Uses the same exported solid mesh. */
export class SoftwareRenderer {
 domElement=document.createElement('canvas'); outputColorSpace=THREE.SRGBColorSpace;
 private ctx=this.domElement.getContext('2d')!; private width=1; private height=1; private ratio=1; private clear='#eef3f3';
 setPixelRatio(r:number){this.ratio=Math.min(r,1.5)}
 setClearColor(c:number){this.clear='#'+c.toString(16).padStart(6,'0')}
 setSize(w:number,h:number){this.width=w;this.height=h;this.domElement.width=w*this.ratio;this.domElement.height=h*this.ratio;this.domElement.style.width=w+'px';this.domElement.style.height=h+'px'}
 render(scene:THREE.Scene,camera:THREE.Camera){
  const ctx=this.ctx,w=this.width,h=this.height;ctx.setTransform(this.ratio,0,0,this.ratio,0,0);ctx.fillStyle=this.clear;ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='#dce7e2';ctx.lineWidth=.5;for(let x=0;x<w;x+=26){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}for(let y=0;y<h;y+=26){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);const transform=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);const list:{a:THREE.Vector3;b:THREE.Vector3;c:THREE.Vector3;z:number;color:string;wire:boolean}[]=[];
  scene.traverseVisible(obj=>{if(!(obj instanceof THREE.Mesh))return;const geom=obj.geometry,position=geom.getAttribute('position');if(!position)return;const index=geom.index;const count=index?index.count:position.count;const matrix=transform.clone().multiply(obj.matrixWorld);const world=new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);const vertices:THREE.Vector3[]=[];for(let i=0;i<position.count;i++)vertices.push(new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(matrix));const materials=Array.isArray(obj.material)?obj.material:[obj.material];
   for(let i=0;i<count;i+=3){const ia=index?index.getX(i):i,ib=index?index.getX(i+1):i+1,ic=index?index.getX(i+2):i+2;const a=vertices[ia],b=vertices[ib],c=vertices[ic];if(a.z>1||b.z>1||c.z>1||a.z< -1||b.z< -1||c.z< -1)continue;if([a,b,c].every(q=>q.x>1)||[a,b,c].every(q=>q.x< -1)||[a,b,c].every(q=>q.y>1)||[a,b,c].every(q=>q.y< -1))continue;
    const group=geom.groups.find((g:{start:number;count:number;materialIndex?:number})=>i>=g.start&&i<g.start+g.count);const material=materials[group?.materialIndex||0] as THREE.MeshStandardMaterial;const wa=new THREE.Vector3().fromBufferAttribute(position,ia),wb=new THREE.Vector3().fromBufferAttribute(position,ib),wc=new THREE.Vector3().fromBufferAttribute(position,ic);const normal=wb.sub(wa).cross(wc.sub(wa)).applyMatrix3(world).normalize();const shade=.62+.38*Math.abs(normal.dot(new THREE.Vector3(.4,-.5,.77).normalize()));const color=(material.color||new THREE.Color(0xb7c7c0)).clone().multiplyScalar(shade).getStyle();list.push({a,b,c,z:(a.z+b.z+c.z)/3,color,wire:material.wireframe});
   }
  });list.sort((a,b)=>b.z-a.z);for(const t of list){ctx.beginPath();ctx.moveTo((t.a.x+1)*w/2,(1-t.a.y)*h/2);ctx.lineTo((t.b.x+1)*w/2,(1-t.b.y)*h/2);ctx.lineTo((t.c.x+1)*w/2,(1-t.c.y)*h/2);ctx.closePath();if(!t.wire){ctx.fillStyle=t.color;ctx.fill();ctx.strokeStyle=t.color;ctx.lineWidth=.4;ctx.stroke()}else{ctx.strokeStyle=t.color;ctx.lineWidth=.6;ctx.stroke()}}
 }
 dispose(){this.domElement.width=0;this.domElement.height=0}
}
