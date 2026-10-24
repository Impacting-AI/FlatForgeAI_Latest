// Test bridge: Python/CAD regressions execute the actual frontend placement
// engine against exact BREP bounds instead of copying its formulas in Python.
import fs from 'node:fs';
import * as THREE from 'three';
import { assemblyPlacements, assemblyMatrix } from '../components/flatforge/assembly-geometry.ts';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const boxes = new Map(input.geometry.entries.map(row => [row.id, new THREE.Box3(
  new THREE.Vector3(...row.bounds.min).multiplyScalar(.001), new THREE.Vector3(...row.bounds.max).multiplyScalar(.001))]));
const placements = assemblyPlacements(input.entries, boxes);
process.stdout.write(JSON.stringify(input.entries.map(entry => ({ ...entry, matrix: assemblyMatrix(entry, placements.get(entry.id).translation) }))));
