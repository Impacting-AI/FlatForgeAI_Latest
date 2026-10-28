import * as THREE from 'three';

// Display-only settings. No source meshes, CAD files or engineering values change.
export const INSPECTION = {
  background: 0xf0f2f4,
  aluminium: 0xb7bdc5,
  paintedFace: 0xc6cbd1,
  edge: 0x414953,
  creaseAngle: 30,
} as const;

export function inspectionMaterial(painted = false) {
  const material = new THREE.MeshStandardMaterial({
    color: painted ? INSPECTION.paintedFace : INSPECTION.aluminium,
    metalness: .28, roughness: .62, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  material.userData.inspectionPainted = painted;
  return material;
}

/** One cached line buffer for a rigid object. Join material/mesh boundaries
 * before finding edges so coplanar triangles do not become engineering lines.
 * EdgesGeometry hashes at 1e-4 in its input units; work in mm to retain small
 * reliefs in metre GLBs. Source buffers and transforms are never modified.
 * Smooth tangent transitions are shown by shading, not fabricated edge lines.
 */
export function inspectionEdges(root: THREE.Object3D, millimetresPerUnit = 1000) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const positions: number[] = [];
  const vertex = new THREE.Vector3();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry, position = geometry.getAttribute('position');
    if (!position) return;
    const matrix = inverse.clone().multiply(object.matrixWorld);
    const index = geometry.index, count = index ? index.count : position.count;
    for (let i = 0; i < count; i++) {
      vertex.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix).multiplyScalar(millimetresPerUnit);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  });
  const triangles = new THREE.BufferGeometry();
  triangles.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const edges = new THREE.EdgesGeometry(triangles, INSPECTION.creaseAngle);
  edges.scale(1 / millimetresPerUnit, 1 / millimetresPerUnit, 1 / millimetresPerUnit);
  triangles.dispose();
  // Retain only the small line buffer, not EdgesGeometry's temporary triangle input.
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().copy(edges), new THREE.LineBasicMaterial({
    color: INSPECTION.edge, transparent: true, opacity: .72,
    depthTest: true, depthWrite: false, toneMapped: false,
  }));
  edges.dispose();
  lines.name = 'Inspection feature edges';
  lines.userData.inspectionEdges = true;
  lines.renderOrder = 1;
  // An overlay must never intercept the existing bend-hover interaction.
  lines.raycast = () => {};
  root.add(lines);
  return lines;
}

export function prepareInspectionModel(root: THREE.Object3D) {
  const metal = inspectionMaterial(), painted = inspectionMaterial(true);
  const originals = new Set<THREE.Material>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) originals.add(material);
    // Only established source tags identify painted faces; do not guess by colour.
    object.material = object.name.includes('_paint') ? painted : metal;
  });
  originals.forEach(material => material.dispose());
  return inspectionEdges(root);
}

export function applyInspectionAppearance(root: THREE.Object3D, distinguishPaint: boolean, wire: boolean) {
  root.traverse(object => {
    if (object.userData.inspectionEdges) object.visible = !wire;
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.wireframe = wire;
      material.color.set(distinguishPaint && material.userData.inspectionPainted ? INSPECTION.paintedFace : INSPECTION.aluminium);
    }
  });
}

export function inspectionLighting(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b6bf, 1.7));
  for (const [position, intensity] of [
    [[3, -4, 5], 2.4], [[-4, 2, 1], 1.3], [[1, 3, -4], .9],
  ] as const) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(position[0], position[1], position[2]);
    scene.add(light);
  }
}


/** Shared renderer/grid configuration for STEP 5 and STEP 6. */
export function configureInspectionRenderer(renderer:THREE.WebGLRenderer){
 renderer.setClearColor(INSPECTION.background);renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
}
export function prepareInspectionGrid(grid:THREE.GridHelper){
 for(const material of Array.isArray(grid.material)?grid.material:[grid.material]){
  material.color.set(0xb9bec6);material.transparent=true;material.opacity=.23;material.depthWrite=false;material.toneMapped=false;
 }
}
