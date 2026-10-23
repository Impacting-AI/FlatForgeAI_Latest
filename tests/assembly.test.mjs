import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assemblyModel, assemblyPlacements, removeAssemblyBranch, resetAssemblySpacing, setAssemblySpacing, setAssemblyTargetFace } from '../components/flatforge/assembly-geometry.ts';
import { decodeAssemblies, encodeAssemblies } from '../components/flatforge/assembly-storage.ts';

globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, values = {}) { super(type); Object.assign(this, values); }
};

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const entry = (id, targetId = null, gap = 10, myFace = '-X', targetFace = '+X') =>
  ({ id, panelId: id, targetId, gap, myFace, targetFace: targetId === null ? null : targetFace });
const box = (x, y, z) => new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(x, y, z).multiplyScalar(.001));

async function fixture(name) {
  const bytes = fs.readFileSync(new URL(`../public/samples/${name}/panel.glb`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = bytes.subarray(28 + jsonLength);
  gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + binary.toString('base64');
  // Textures do not affect geometry. Omit them in this Node-only GLTFLoader test.
  delete gltf.images; delete gltf.textures; delete gltf.materials;
  gltf.meshes.forEach(mesh => mesh.primitives.forEach(primitive => delete primitive.material));
  const loaded = await new GLTFLoader().parseAsync(JSON.stringify(gltf), '');
  return assemblyModel(loaded.scene);
}

test('horizontal 1, 5, 10, 25, 50, 100 mm gaps measure correctly and preserve dimensions', () => {
  const bounds = new Map([['a', box(1000, 400, 80)], ['b', box(250, 600, 120)]]);
  for (const gap of [1, 5, 10, 25, 50, 100]) {
    const placed = assemblyPlacements([entry('a'), entry('b', 'a', gap)], bounds);
    close((placed.get('b').bounds.min.x - placed.get('a').bounds.max.x) * 1000, gap);
    assert.deepEqual(placed.get('b').bounds.getSize(new THREE.Vector3()).toArray(), bounds.get('b').getSize(new THREE.Vector3()).toArray());
  }
});

test('real folded GLBs retain report dimensions in mm and have measured 10 mm gaps', async () => {
  for (const name of ['1570', '1619', '1648']) {
    const model = await fixture(name);
    const report = JSON.parse(fs.readFileSync(new URL(`../public/samples/${name}/report.json`, import.meta.url)));
    model.bounds.getSize(new THREE.Vector3()).toArray().forEach((metres, axis) => close(metres * 1000, report.bbox[axis], .002));
    assert.deepEqual(model.group.scale.toArray(), [1, 1, 1]);
    for (const gap of [1, 5, 10, 25, 50, 100]) {
      const placed = assemblyPlacements([entry('a'), entry('b', 'a', gap)], new Map([['a', model.bounds], ['b', model.bounds]]));
      close((placed.get('b').bounds.min.x - placed.get('a').bounds.max.x) * 1000, gap);
    }
  }
});

test('six face directions preserve exact envelope gaps at all requested distances', () => {
  for (const targetFace of ['+X', '-X', '+Y', '-Y', '+Z', '-Z']) {
    const myFace = (targetFace[0] === '+' ? '-' : '+') + targetFace[1];
    const axis = targetFace[1].toLowerCase();
    for (const gap of [0, 1, 5, 10, 25, 50, 100]) {
      const placed = assemblyPlacements([entry('a'), entry('b', 'a', gap, myFace, targetFace)], new Map([['a', box(1000, 400, 80)], ['b', box(250, 600, 120)]]));
      const a = placed.get('a').bounds, b = placed.get('b').bounds;
      close((targetFace[0] === '+' ? b.min[axis] - a.max[axis] : a.min[axis] - b.max[axis]) * 1000, gap);
    }
  }
});

test('three controls work independently and together without moving the root', () => {
  const a = entry('a');
  const bounds = new Map([['a', box(1000, 400, 80)], ['b', box(250, 600, 120)]]);
  const baseline = assemblyPlacements([a, entry('b', 'a')], bounds);
  for (const y of [-50, 0, 50]) for (const z of [-25, 0, 25]) {
    const b = setAssemblySpacing(setAssemblySpacing(setAssemblySpacing(entry('b', 'a'), 'x', 100), 'y', y), 'z', z);
    const placed = assemblyPlacements([a, b], bounds);
    assert.deepEqual(placed.get('a'), baseline.get('a'));
    close((placed.get('b').bounds.min.x - placed.get('a').bounds.max.x) * 1000, 100);
    close((placed.get('b').translation.y - baseline.get('b').translation.y) * 1000, y);
    close((placed.get('b').translation.z - baseline.get('b').translation.z) * 1000, z);
  }
});

test('raised ancestors carry descendants, preserving relative connections and branches', () => {
  const entries = [entry('a'), { ...entry('b', 'a'), offsets: { x: 0, y: -40, z: 50 } }, entry('c', 'b', 25), entry('d', 'a', 10, '-Z', '+Z')];
  const bounds = new Map(entries.map(e => [e.id, box(e.id === 'a' ? 1000 : 400, 500, 100)]));
  const placed = assemblyPlacements(entries, bounds);
  close(placed.get('b').bounds.min.z * 1000, 50);
  close(placed.get('c').bounds.min.z * 1000, 50);
  close((placed.get('c').bounds.min.x - placed.get('b').bounds.max.x) * 1000, 25);
  close((placed.get('d').bounds.min.z - placed.get('a').bounds.max.z) * 1000, 10);
  assert.deepEqual(removeAssemblyBranch(entries, 'b').map(e => e.id), ['a', 'd']);
  assert.deepEqual(removeAssemblyBranch(entries, 'a'), []);
});

test('rotated and translated GLB nodes retain geometry; placements use transformed bounds', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.5, .2, .03));
  mesh.rotation.set(.2, .7, .4); mesh.position.set(3, -2, 1);
  const vertices = Array.from(mesh.geometry.attributes.position.array);
  const model = assemblyModel(mesh);
  const before = model.bounds.getSize(new THREE.Vector3());
  const placed = assemblyPlacements([entry('a'), entry('b', 'a', 10)], new Map([['a', model.bounds], ['b', model.bounds]]));
  model.group.position.copy(placed.get('b').translation);
  const actual = new THREE.Box3().setFromObject(model.group, true);
  close((actual.min.x - placed.get('a').bounds.max.x) * 1000, 10);
  actual.getSize(new THREE.Vector3()).toArray().forEach((n, i) => close(n, before.toArray()[i]));
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), vertices);
  assert.deepEqual(mesh.rotation.toArray(), [.2, .7, .4, 'XYZ']);
});

test('spacing reset and connection-axis changes retain well-defined values', () => {
  const b = { ...entry('b', 'a', 25), offsets: { x: 0, y: -45, z: 50 } };
  const changed = setAssemblyTargetFace(b, '+Z');
  assert.equal(changed.gap, 25);
  assert.deepEqual(changed.offsets, { x: 0, y: -45, z: 0 });
  assert.deepEqual(resetAssemblySpacing(b), { ...b, gap: 10, offsets: { x: 0, y: 0, z: 0 } });
  assert.equal(b.offsets.z, 50);
});

test('mm-only storage round-trips layouts and restores legacy gap-only entries', () => {
  const projects = { first: [entry('a'), { ...entry('b', 'a', 5.25), offsets: { x: 0, y: -10.25, z: 50 } }], second: [entry('c')] };
  assert.deepEqual(decodeAssemblies(encodeAssemblies(projects)), projects);
  const restored = decodeAssemblies(encodeAssemblies(projects)).first;
  const bounds = new Map([['a', box(1000, 400, 80)], ['b', box(250, 600, 120)]]);
  assert.deepEqual(assemblyPlacements(restored, bounds), assemblyPlacements(projects.first, bounds));
  assert.deepEqual(decodeAssemblies(null), {});
  assert.throws(() => decodeAssemblies('{bad json'));
  assert.throws(() => decodeAssemblies(JSON.stringify({ version: 1, units: 'metres', projects })));
});

test('invalid distances, missing targets and cycles fail explicitly without guessing', () => {
  const bounds = new Map([['a', box(1000, 400, 80)], ['b', box(250, 600, 120)]]);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => setAssemblySpacing(entry('b', 'a'), 'z', value));
  assert.throws(() => setAssemblySpacing(entry('b', 'a'), 'x', -1));
  assert.throws(() => assemblyPlacements([entry('a'), entry('b', 'a', NaN)], bounds));
  assert.throws(() => assemblyPlacements([entry('a'), entry('b', 'missing')], bounds));
  assert.throws(() => assemblyPlacements([entry('a', 'b'), entry('b', 'a')], bounds));
  assert.throws(() => assemblyPlacements([entry('a'), { ...entry('b', 'a'), offsets: { x: 1, y: 0, z: 0 } }], bounds));
  assert.throws(() => decodeAssemblies(encodeAssemblies({ p: [entry('b', 'missing')] })));
});
