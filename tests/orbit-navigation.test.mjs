import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createOrbitNavigation, NAVIGATION } from '../components/flatforge/orbit-navigation.ts';

// Only what OrbitControls and the navigation use from a canvas.
class Canvas extends EventTarget {
  constructor() { super(); this.clientWidth = 800; this.clientHeight = 600; this.style = {}; this.ownerDocument = new EventTarget(); }
  getRootNode() { return this.ownerDocument; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  releasePointerCapture() {}
}
// A browser event reaches the canvas first, then bubbles to the document where OrbitControls listens.
function send(canvas, type, values) {
  const data = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 400, clientY: 300, ...values };
  data.pageX = data.clientX; data.pageY = data.clientY;
  for (const target of [canvas, canvas.ownerDocument]) target.dispatchEvent(Object.assign(new Event(type), data));
}
const Z = new THREE.Vector3(0, 0, 1);
const box = new THREE.Box3(new THREE.Vector3(-1, -.5, 0), new THREE.Vector3(1, .5, .4));
const centre = box.getCenter(new THREE.Vector3());

function setup(options) {
  const canvas = new Canvas(), camera = new THREE.PerspectiveCamera(32, 4 / 3, .001, 1000);
  const navigation = createOrbitNavigation(camera, canvas, options);
  navigation.setView(box, new THREE.Vector3(1, -1.25, 1.15), 6);
  let time = 0;
  const run = (frames = 60, step = 1000 / 60) => { for (let i = 0; i < frames; i++) navigation.update(time += step); };
  run(1);
  const backward = () => camera.position.clone().sub(navigation.controls.target).normalize();
  const screenUp = () => new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const screenRight = () => new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  function drag(dx, dy, { steps = 20, settle = true, values = {} } = {}) {
    // The first movement only crosses the click tolerance.
    const start = 400 + NAVIGATION.clickTolerance + 1;
    send(canvas, 'pointerdown', values);
    send(canvas, 'pointermove', { ...values, clientX: start });
    for (let i = 1; i <= steps; i++) { send(canvas, 'pointermove', { ...values, clientX: start + dx * i / steps, clientY: 300 + dy * i / steps }); run(1); }
    send(canvas, 'pointerup', { ...values, clientX: start + dx, clientY: 300 + dy, buttons: 0 });
    if (settle) run(120);
  }
  const project = point => { camera.updateMatrixWorld(); return point.clone().project(camera); };
  return { canvas, camera, navigation, run, drag, backward, screenUp, screenRight, project };
}
/** Drag length in pixels for one full turn in a 600 px viewer. */
const turn = 600 / NAVIGATION.turnsPerHeight;
const close = (a, b, tolerance = 1e-3) => assert.ok(a.distanceTo(b) < tolerance, `${a.toArray()} != ${b.toArray()}`);

test('a vertical drag passes over the top and underneath and returns after a full turn', () => {
  for (const sign of [1, -1]) {
    const view = setup(), start = view.camera.position.clone(), heights = [];
    let upsideDown = 0, previous = view.camera.quaternion.clone();
    for (let i = 0; i < 24; i++) {
      view.drag(0, sign * turn / 24, { steps: 4 });
      heights.push(view.backward().z);
      if (view.screenUp().z < 0) upsideDown++;
      assert.ok(Math.abs(view.screenRight().z) < 1e-4, 'the horizon stays level');
      // 15° steps: a flip at a pole would show up as a far larger jump.
      assert.ok(Math.abs(previous.angleTo(view.camera.quaternion) - Math.PI / 12) < .01, 'even movement through the poles');
      previous.copy(view.camera.quaternion);
      assert.ok(Math.abs(view.camera.position.distanceTo(centre) - 6) < 1e-6, 'fixed distance about a fixed centre');
    }
    assert.ok(Math.max(...heights) > .98 && Math.min(...heights) < -.98, 'top and bottom were both reached');
    assert.ok(upsideDown >= 8, 'the far side is passed upside down');
    close(view.camera.position, start, .01);
  }
});

test('horizontal orbit is unlimited and keeps the elevation', () => {
  const view = setup(), start = view.camera.position.clone(), height = view.backward().z, azimuths = new Set();
  for (let i = 0; i < 3 * 8; i++) {
    view.drag(turn / 8, 0, { steps: 4 });
    const direction = view.backward();
    assert.ok(Math.abs(direction.z - height) < 1e-4);
    azimuths.add(Math.round(THREE.MathUtils.radToDeg(Math.atan2(direction.y, direction.x)) / 45));
  }
  assert.ok(azimuths.size >= 8);
  close(view.camera.position, start, .01);
});

test('the model follows the pointer both upright and upside down', () => {
  for (const over of [0, turn / 2]) {
    const view = setup();
    if (over) view.drag(0, over);
    // A point on the near side of the model must move the same way as the pointer.
    const near = centre.clone().addScaledVector(view.backward(), .3);
    const before = view.project(near);
    view.drag(30, 0);
    assert.ok(view.project(near).x > before.x + .01);
    const level = view.project(near);
    view.drag(0, 30);
    assert.ok(view.project(near).y < level.y - .01);
  }
});

test('passing over a pole mid-drag does not reverse the horizontal direction', () => {
  const view = setup();
  send(view.canvas, 'pointerdown', {});
  let x = 420, y = 300, last = null;
  send(view.canvas, 'pointermove', { clientX: x, clientY: y });
  for (let i = 0; i < 80; i++) {
    send(view.canvas, 'pointermove', { clientX: x += 3, clientY: y += 8 }); view.run(1);
    const q = view.camera.quaternion.clone();
    if (last) assert.ok(last.angleTo(q) < .15, 'no jump');
    last = q;
  }
});

test('rotation eases in, finishes quickly and takes the same time at any frame rate', () => {
  const finalAngle = [];
  for (const [step, frames] of [[1000 / 60, 12], [1000 / 144, 29]]) {
    const view = setup(), start = view.camera.quaternion.clone();
    send(view.canvas, 'pointerdown', {});
    send(view.canvas, 'pointermove', { clientX: 410 });
    send(view.canvas, 'pointermove', { clientX: 510 });
    send(view.canvas, 'pointerup', { clientX: 510, buttons: 0 });
    view.navigation.update(1000);
    for (let i = 1; i <= frames; i++) view.navigation.update(1000 + i * step);
    finalAngle.push(start.angleTo(view.camera.quaternion));
  }
  const full = setup(), start = full.camera.quaternion.clone();
  full.drag(100, 0);
  const total = start.angleTo(full.camera.quaternion);
  assert.ok(finalAngle[0] > total * .93, 'most of the movement is done within about 200 ms');
  assert.ok(Math.abs(finalAngle[0] - finalAngle[1]) < total * .03, '60 Hz and 144 Hz agree');
  const rest = full.camera.position.clone();
  full.run(300);
  close(full.camera.position, rest, 1e-9);
});

test('a click, a small wobble and the right button do not rotate', () => {
  const view = setup(), start = view.camera.quaternion.clone();
  send(view.canvas, 'pointerdown', {});
  send(view.canvas, 'pointermove', { clientX: 403, clientY: 303 });
  send(view.canvas, 'pointerup', { buttons: 0 });
  view.run(30);
  assert.equal(view.navigation.moved, false);
  assert.ok(start.angleTo(view.camera.quaternion) < 1e-6);
  view.drag(100, 60, { values: { button: 2, buttons: 2 } });
  assert.ok(start.angleTo(view.camera.quaternion) < 1e-6, 'right drag pans without turning');
  assert.ok(view.navigation.controls.target.distanceTo(centre) > .05);
  view.drag(100, 0);
  assert.equal(view.navigation.moved, true);
});

test('a released button, a cancelled pointer and a disabled viewer stop the orbit', () => {
  const view = setup();
  send(view.canvas, 'pointerdown', {});
  send(view.canvas, 'pointermove', { clientX: 450 });
  send(view.canvas, 'pointermove', { clientX: 700, buttons: 0 });
  send(view.canvas, 'pointermove', { clientX: 100 });
  const start = view.camera.quaternion.clone();
  view.run(60);
  assert.ok(start.angleTo(view.camera.quaternion) < 1e-6);
  send(view.canvas, 'pointercancel', {});
  view.navigation.controls.enabled = false;
  view.drag(200, 0);
  assert.ok(start.angleTo(view.camera.quaternion) < 1e-6);
});

test('one finger orbits and a second finger hands over to zoom and pan', () => {
  const view = setup(), start = view.camera.quaternion.clone();
  const finger = { pointerType: 'touch' };
  view.drag(100, 0, { values: finger });
  assert.ok(start.angleTo(view.camera.quaternion) > .3);
  const turned = view.camera.quaternion.clone();
  const at = (id, x) => ({ ...finger, pointerId: id, clientX: x });
  send(view.canvas, 'pointerdown', at(1, 300));
  send(view.canvas, 'pointerdown', at(2, 500));
  assert.equal(view.navigation.moved, true);
  send(view.canvas, 'pointermove', at(2, 600)); view.run(30);
  assert.ok(turned.angleTo(view.camera.quaternion) < 1e-6);
  assert.ok(view.camera.position.distanceTo(view.navigation.controls.target) < 5.9, 'pinch zoomed in');
});

test('setView cancels movement in progress and handles the straight top view', () => {
  const view = setup(), start = view.camera.position.clone();
  view.drag(250, 170, { settle: false });
  view.navigation.setView(box, new THREE.Vector3(1, -1.25, 1.15), 6);
  view.run(60);
  close(view.camera.position, start);
  assert.ok(view.screenUp().z > 0 && Math.abs(view.screenRight().z) < 1e-6);
  view.navigation.setView(box, Z, 6);
  view.run(30);
  close(view.backward(), Z);
  close(view.screenUp(), new THREE.Vector3(0, 1, 0));
});

test('the pivot cannot leave the model, and follow() keeps the view on a changed shape', () => {
  const view = setup(), radius = box.getSize(new THREE.Vector3()).length() / 2;
  for (let i = 0; i < 12; i++) view.drag(300, 0, { values: { button: 2, buttons: 2 } });
  assert.ok(view.navigation.controls.target.distanceTo(centre) <= radius + 1e-6);
  view.navigation.setView(box, new THREE.Vector3(1, -1, 1), 6);
  const orientation = view.camera.quaternion.clone(), shifted = box.clone().translate(new THREE.Vector3(2, 1, 0));
  view.navigation.follow(shifted);
  view.run(10);
  close(view.navigation.controls.target, shifted.getCenter(new THREE.Vector3()));
  assert.ok(orientation.angleTo(view.camera.quaternion) < 1e-6);
});

test('zoomed in, orbit pivots on the surface at the view centre without moving the view', () => {
  let point = null;
  const view = setup({ pickCentre: () => point });
  point = centre.clone().addScaledVector(view.backward(), .4);
  view.drag(100, 0);
  close(view.navigation.controls.target, centre); // the whole panel still turns about its centre
  view.navigation.setView(box, new THREE.Vector3(1, -1, 1), 6);
  const near = centre.clone().addScaledVector(view.backward(), 1.5);
  view.camera.position.copy(near);
  view.run(1);
  point = centre.clone().addScaledVector(view.backward(), .4);
  const screen = view.project(point);
  view.drag(120, 90);
  close(view.navigation.controls.target, point);
  close(view.project(point), screen);
});

test('a saved pose is restored relative to the rebuilt model', () => {
  const view = setup();
  view.drag(180, 400);
  const pose = view.navigation.getPose(), position = view.camera.position.clone(), orientation = view.camera.quaternion.clone();
  view.navigation.setView(box, Z, 6);
  view.navigation.setPose(pose);
  view.run(10);
  close(view.camera.position, position);
  assert.ok(orientation.angleTo(view.camera.quaternion) < 1e-3);
});
