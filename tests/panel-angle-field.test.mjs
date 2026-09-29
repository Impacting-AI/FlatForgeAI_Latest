import {test} from 'node:test';
import assert from 'node:assert/strict';
import {panelAngleField} from '../components/flatforge/panel-angle-field.ts';
test('detected angle is read only and takes precedence over unused fallback',()=>{
 assert.deepEqual(panelAngleField({values:[120],unresolved:0},90,false,''),{value:'120',type:'number',readOnly:true});
});
test('mixed drawing angles stay mixed in one field',()=>{
 assert.deepEqual(panelAngleField({values:[90,120],unresolved:0},undefined,false,''),{value:'90°, 120°',type:'text',readOnly:true});
});
test('one editable fallback without invented 90',()=>{
 assert.equal(panelAngleField({values:[],unresolved:3},undefined,false,'').value,'');
 assert.equal(panelAngleField({values:[],unresolved:3},120,false,'').value,'120');
 assert.deepEqual(panelAngleField(undefined,120,true,''),{value:'',type:'number',readOnly:false});
});
