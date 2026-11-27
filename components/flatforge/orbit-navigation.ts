import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const NAVIGATION = {
  /** Turns of the model for a drag across the full viewer height. */
  turnsPerHeight: .6,
  /** Share of the remaining movement applied in each 60 Hz frame. */
  damping: .25,
  /** Pointer travel in pixels that separates a drag from a click. */
  clickTolerance: 6,
  /** Closer than this share of the framed distance counts as inspecting a detail. */
  detailZoom: .5,
} as const;

const WORLD_UP = new THREE.Vector3(0, 0, 1);

export type CameraPose = { offset: THREE.Vector3; up: THREE.Vector3; pan: THREE.Vector3 };

/**
 * CAD-style navigation for a Z-up model: left drag orbits, right drag pans, wheel zooms.
 *
 * OrbitControls keeps the camera between the two poles, so it only zooms and pans here.
 * Orbiting turns the camera about the model's Z axis (horizontal drag) and about the
 * screen's horizontal axis (vertical drag). Neither has a limit, the camera can pass
 * over the top and underneath, and the horizon stays level.
 */
export function createOrbitNavigation(camera: THREE.PerspectiveCamera, canvas: HTMLElement, options: {
  /** Model point at the middle of the view, used as the pivot when zoomed in. */
  pickCentre?: () => THREE.Vector3 | null;
  /** False lets panning leave the framed box, for scenes whose parts move apart. */
  limitPan?: boolean;
} = {}) {
  camera.up.copy(WORLD_UP);
  const controls = new OrbitControls(camera, canvas);
  controls.enableRotate = false;
  controls.enableDamping = true;
  controls.dampingFactor = NAVIGATION.damping;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 1;
  controls.screenSpacePanning = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  // One finger is handled below; OrbitControls keeps the two-finger gesture.
  controls.touches = { TWO: THREE.TOUCH.DOLLY_PAN };

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { id: number; x: number; y: number; started: boolean; direction: number } | null = null;
  let yaw = 0, pitch = 0, framed = 0, moved = false, previous: number | null = null;

  function turn(horizontal: number, vertical: number) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const rotation = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, horizontal)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, vertical));
    camera.position.sub(controls.target).applyQuaternion(rotation).add(controls.target);
    // Carrying "up" with the camera is what removes the stop at the poles.
    camera.up.applyQuaternion(rotation).normalize();
    camera.lookAt(controls.target);
  }

  /** Zoomed in, the pivot moves along the view axis onto the surface, so the view does not change. */
  function pivotOnDetail() {
    if (camera.position.distanceTo(controls.target) >= framed * NAVIGATION.detailZoom) return;
    const point = options.pickCentre?.();
    if (point && camera.position.distanceTo(point) >= controls.minDistance) controls.target.copy(point);
  }

  function down(event: Event) {
    const e = event as PointerEvent;
    if (!pointers.size) moved = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Taking hold of the model stops any movement still being smoothed.
    yaw = pitch = 0;
    if (pointers.size > 1) { drag = null; moved = true; return; }
    if (!controls.enabled) return;
    if (e.pointerType !== 'touch' && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, started: false, direction: 1 };
  }

  function move(event: Event) {
    const e = event as PointerEvent;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag || drag.id !== e.pointerId || !controls.enabled) return;
    // The button can be released where no pointerup reaches the canvas.
    if (e.pointerType !== 'touch' && !(e.buttons & 1)) { release(e); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.started) {
      if (dx * dx + dy * dy <= NAVIGATION.clickTolerance ** 2) return;
      drag.started = moved = true;
      // Upside down, horizontal turning is mirrored so the model still follows the pointer.
      // Fixed for the whole drag, so passing over a pole never reverses it midway.
      drag.direction = camera.up.z < -1e-6 ? -1 : 1;
      pivotOnDetail();
    } else {
      const radiansPerPixel = 2 * Math.PI * NAVIGATION.turnsPerHeight / Math.max(1, canvas.clientHeight);
      yaw -= dx * radiansPerPixel * drag.direction;
      pitch -= dy * radiansPerPixel;
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
  }

  function release(event: Event) {
    const id = (event as PointerEvent).pointerId;
    if (!pointers.delete(id)) return;
    if (drag?.id === id) drag = null;
    // Lifting one of two fingers continues as a one-finger orbit from where it is.
    if (pointers.size === 1 && (event as PointerEvent).pointerType === 'touch') {
      const [[other, at]] = pointers;
      drag = { id: other, ...at, started: false, direction: 1 };
    }
  }

  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', release], ['pointercancel', release], ['lostpointercapture', release]] as const;
  for (const [type, listener] of listeners) canvas.addEventListener(type, listener);

  /** Call once per animation frame. */
  function update(now = performance.now()) {
    const frames = previous === null ? 1 : Math.min(6, Math.max(0, now - previous) * .06);
    previous = now;
    // The same smoothing time on 60 Hz and 144 Hz displays.
    const share = 1 - (1 - NAVIGATION.damping) ** frames;
    controls.dampingFactor = share;
    if (yaw || pitch) {
      const rest = Math.abs(yaw) + Math.abs(pitch) < 1e-4 ? 1 : share;
      const horizontal = yaw * rest, vertical = pitch * rest;
      yaw -= horizontal;
      pitch -= vertical;
      turn(horizontal, vertical);
    }
    controls.update();
  }

  /** Ends all smoothed movement, so a new camera position stays exactly where it is put. */
  function settle() {
    yaw = pitch = 0;
    drag = null;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
  }

  /** Centres on the box. Unless disabled, the target then stays within its bounding sphere. */
  function bound(box: THREE.Box3) {
    box.getCenter(controls.cursor);
    controls.maxTargetRadius = options.limitPan === false ? Infinity : box.getSize(new THREE.Vector3()).length() / 2;
  }

  /** Looks at the centre of the box from the given direction. */
  function setView(box: THREE.Box3, direction: THREE.Vector3, distance: number) {
    settle();
    framed = distance;
    bound(box);
    const from = direction.clone().normalize();
    camera.up.copy(WORLD_UP).addScaledVector(from, -from.z);
    // Looking straight along Z, the screen's top points along +Y.
    if (camera.up.lengthSq() < 1e-6) camera.up.set(0, 1, 0);
    camera.up.normalize();
    controls.target.copy(controls.cursor);
    camera.position.copy(controls.cursor).addScaledVector(from, distance);
    controls.update();
  }

  /** Moves with a model whose shape changed, keeping orientation, zoom and pan. */
  function follow(box: THREE.Box3) {
    const shift = box.getCenter(new THREE.Vector3()).sub(controls.cursor);
    camera.position.add(shift);
    controls.target.add(shift);
    bound(box);
    controls.update();
  }

  function getPose(): CameraPose {
    return { offset: camera.position.clone().sub(controls.target), up: camera.up.clone(), pan: controls.target.clone().sub(controls.cursor) };
  }

  function setPose(pose: CameraPose) {
    settle();
    controls.target.copy(controls.cursor).add(pose.pan);
    camera.position.copy(controls.target).add(pose.offset);
    camera.up.copy(pose.up);
    controls.update();
  }

  return {
    controls, update, setView, follow, getPose, setPose,
    /** True when the latest press became a drag or a two-finger gesture, not a click. */
    get moved() { return moved; },
    dispose() {
      for (const [type, listener] of listeners) canvas.removeEventListener(type, listener);
      controls.dispose();
    },
  };
}
