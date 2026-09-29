import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fallbackRotation} from '../components/flatforge/angle-choice.ts';
test('explicit ninety-degree approval requires a direction',()=>{
 assert.equal(fallbackRotation(90,'included',1),90);
 assert.equal(fallbackRotation(90,'included',-1),-90);
 assert.throws(()=>fallbackRotation(90,'included',undefined));
});
test('custom included angle and rotation are distinct',()=>{
 assert.equal(fallbackRotation(120,'included',1),60);
 assert.equal(fallbackRotation(120,'included',-1),-60);
 assert.equal(fallbackRotation(120,'rotation',1),120);
});
test('invalid fallback cannot become a fold',()=>{
 for(const value of [0,180,-90,NaN,Infinity])assert.throws(()=>fallbackRotation(value,'included',1));
});
