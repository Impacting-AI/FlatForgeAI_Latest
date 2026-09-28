// Cross-language check against the exact matrices/crease points emitted by CAD.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {hingeTransforms,bendSegments} from '../components/flatforge/BendOverlay.ts';
const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const frames=hingeTransforms(data,1);
for(const f of data.faces){const m=frames.get(f.id).elements;
 for(let i=0;i<3;i++){assert.ok(Math.abs(m[12+i]-f.translation[i])<1e-6);
  for(let j=0;j<3;j++)assert.ok(Math.abs(m[j*4+i]-f.rotation[i][j])<1e-9);}}
for(const e of data.bends){const lines=bendSegments(data,{...e,folded_lines:undefined},1,frames);
 assert.equal(lines.length,e.folded_lines.length);
 for(let i=0;i<lines.length;i++)for(let j=0;j<2;j++)for(let k=0;k<3;k++)
  assert.ok(Math.abs(lines[i][j].getComponent(k)-e.folded_lines[i].points[j][k])<1e-6);}
console.log(`Verified ${data.bends.length} folded hinge overlays against backend transforms`);
