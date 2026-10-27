# STEP 6: directional clearances and assembly STEP export

## Root cause and units

The earlier millimetre fix remains: CAD/DXF/STEP coordinates are mm; the backend
GLB exporter writes metres. The viewer must not scale the GLB a second time.
Only assembly translations convert between mm and metres.

The subsequent overlap problem had two causes:

1. Only the selected connection-face axis used a boundary gap. The other inputs
   added signed translations to center/bottom alignment. They did not include
   either panel's folded extents, so a 30 mm shift was not a 30 mm clearance.
2. Non-opposing face selections used different signed half-extents while keeping
   the panel's rotation unchanged. This could put a panel on the wrong side of
   its target or inside it. The old sampled-vertex clash check was not an exact
   solid-intersection test.

## Directional gap model

FlatForge remains **Z-up**. Model coordinates and rotations are not swapped to
match a different screen convention:

| Control | Positive side | Negative side |
| --- | --- | --- |
| Horizontal (X) | Right | Left |
| Vertical (Z) | Above | Below |
| Front / back (Y) | Back | Front |

The connection face determines the primary axis and side. On each other axis,
choose **Keep alignment** or an explicit positive/negative side. Keep alignment
adds no directional gap. Selecting a side activates its non-negative gap input;
zero then means touching support planes. This distinction avoids guessing which
side of a target an additional gap should use.

For an active positive direction, the child minimum equals the target maximum
plus the gap. For a negative direction, the child maximum equals the target
minimum minus the gap. These are **support planes of the actual rotated folded
geometry**, not extents of the flat DXF, center-to-center measurements, or a
rotation of the unrotated bounding box. Active constraints apply independently
on each world axis. Other axes retain the existing center/bottom alignment.
Multiple active gaps produce a diagonal arrangement with the requested clearance
on each selected axis; they do not claim that the shortest 3D surface distance
is any single gap value.

Changing a gap leaves the root, rotations, other axis constraints and unrelated
branches unchanged. Descendants follow their target and retain their own
relationships. Non-opposing envelope faces are rejected for directional gap
connections; select opposing faces instead of implicitly rotating the panel.
Changing the connection face reassigns the primary gap to the new direction.
Reset restores the 10 mm primary gap, aligned other axes and zero legacy shifts.

## One set of transformations

Live placement now uses `backend/flatforge/assembly_connections.py`; see
[face connections](assembly-face-connections.md) for the selected-face model.
Existing envelope layouts retain their positions through the same backend solver.

1. `POST /projects/{id}/assembly/place` validates project membership and panel
   revisions, imports approved STEP BREPs and returns authoritative rigid matrices
   and exact placed bounds in mm. Envelope placement uses rotated solid extents;
   face connections use original CAD planes and picked anchors.
2. The viewer applies those matrices, dividing only translations by 1000 for its
   existing metre GLBs. Source GLB node transforms are preserved.
3. `POST /projects/{id}/assembly/validate` checks those exact matrices against
   requested clearances, face relationships and all-pair solid intersections.
4. A valid result signs the matrices and source identities. STEP and GLB exports
   consume that snapshot. No independent frontend face-placement calculation runs.

The previous `/assembly/geometry` endpoint remains available for compatibility.
`assembly-geometry.ts` retains the offline sample engine and the compatibility
reference exercised by regression tests against the backend solver.

Validation runs after spacing edits; outdated requests are cancelled and their
responses ignored. CAD export is disabled while checking, on errors, or when
conflicts exist. A late approval for an older gap cannot enable a different
layout's export. Spacing edits update the existing canvas and preserve its camera,
zoom, orbit and pan.

Offline sample mode uses the retained frontend envelope engine with GLB bounds.
It is explicitly labelled as a sample preview; exact CAD validation and assembly
STEP export require the Python service. It does not fabricate STEP from meshes.

## Collision and contact checks

The backend first rejects disjoint bounding intervals, then uses OpenCascade
BREP common-volume tests for potential intersections. This catches thin crossing
solids that have no sampled vertices inside one another. It checks every pair,
including siblings and unrelated branches, not just each child and its target.

Touching surfaces with no positive common volume are reported as contacts and
are permitted. Numerical thresholds are 0.00001 mm for clearance/contact checks
and 0.000001 mm³ for intersection volume. These address kernel precision and
are independent of the experimental drawing-tolerance switch. Intersections
highlight the affected panels, identify the conflicting pair and block export.
The application never moves other branches automatically to resolve a conflict.
The original approximate mesh clash check remains available only for offline
samples; live results use CAD common volume.

## STEP export

**Export assembly as STEP (.step)** downloads a single named CAD assembly. It
reuses the original BREP solids and applies the signed preview matrices using
CadQuery/OpenCascade locations. Each entry remains an individual named part;
repeated instances of a source panel remain separate instances. The exporter
uses normal assembly mode, never fused mode. Individual panel files, thickness,
analytic bend surfaces, STEP 5 export and source geometry are unchanged.

`POST /projects/{id}/assembly/step` rechecks the project, current approved panel
revisions, artifact identities, clearances and collisions. It rejects altered
or stale snapshots. Before returning the file it reimports it with the CAD kernel
and verifies validity, expected solid count, placed bounds and volumes. Temporary
files are removed after the response or on error. No partial file is returned
when a panel is unavailable or a CAD check fails.

## Existing layouts and application scope

Browser-local `flatforge.assemblies.v1` data remains compatible. Optional
`spacing` constraints and rotation quaternions are stored with the existing entry
IDs and connection tree. Old offset layouts retain their saved positions; they
are not silently reinterpreted as gaps. **Use directional gaps** explicitly
converts an old entry while retaining its tangential alignment shifts. Those
shifts are identified in the direction controls. Reset intentionally removes them.
Previously invalid or intersecting layouts remain visible as conflicts and must
be corrected before CAD export.

If a source drawing returns to review or becomes unavailable, its saved assembly
entry is retained with a recoverable error. Export cannot silently omit it.
Restoring the approved drawing result restores the assembly with its saved gaps.

No database migration, CAD rebuild or new material parameters are required.
Deploy/restart both frontend and Python API together. Assemblies use approved
CAD panel results, consistent with STEP 5's export policy. Source extraction,
STEP 3 review state, STEP 4 calculations, individual drawing routes and project
management are not changed.

## Verification

```sh
node --experimental-strip-types --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint components/flatforge/AssemblyViewer.tsx components/flatforge/AssemblySpacing.tsx components/flatforge/assembly-cad.ts components/flatforge/assembly-geometry.ts components/flatforge/assembly-storage.ts
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest backend/tests/test_assembly_cad.py backend/tests/test_project_context.py backend/tests/test_workflow.py::test_upload_review_worker_exports_and_persistence backend/tests/test_bend_editor_workflow.py -q
node tests/assembly.browser.mjs
node tests/step3-review.browser.mjs
node tests/drawing-workflow.browser.mjs
pnpm build
```

Browser suites require Chromium and Playwright, with `FLATFORGE_CHROMIUM` and
`PLAYWRIGHT_MODULE` available for external installations. Run them sequentially.
The assembly suite launches a disposable real Python API using bundled folded
STEP/GLB fixtures. Browser transport forwards to that API; CAD answers are not
mocked. It downloads STEP and GLB files, measures GLB coordinates, and opens each
STEP with CadQuery/OpenCascade to compare solids against the exact preview
matrices, bounds, volumes and face types. FreeCAD GUI testing is not claimed.

Coverage includes 0/1/5/10/25/50/100 mm gaps, six directions, unequal and irregular
folded parts, preserved rotations, combined gaps, branch collisions, thin solid
crossings, permitted contact, repeated parts, invalid transforms, missing and
foreign project sources, stale revisions/tokens, delayed validation, export
errors/retry, legacy offsets, reload, project isolation, viewport interactions,
mobile controls, and existing review/calculation/individual STEP workflows.

Executed on 2026-10-24: **35 Node tests and 14 Python API/CAD/workflow tests
passed**. The assembly, STEP 3 review and drawing-navigation browser suites all
passed. The final assembly run verified five downloaded STEP assemblies with
two or three solids each, plus an API regression exported four parts including
a repeated panel. The tests reopened and measured these files with
CadQuery/OpenCascade; they did not use FreeCAD's graphical interface.
TypeScript and the focused assembly-file ESLint checks passed. Whole-application
ESLint is not claimed by this report. The final production build passed, with
Vinext's bundle-size warning and route-classification notice.

## Changed files

| Area | Files |
| --- | --- |
| Placement, persistence and types | `components/flatforge/assembly-geometry.ts`, `assembly-storage.ts`, `types.ts` |
| STEP 6 UI and shared CAD requests | `components/flatforge/AssemblySpacing.tsx`, `AssemblyViewer.tsx`, `assembly-cad.ts`, `FlatForge.tsx`, `app/globals.css` |
| CAD validation and export API | `backend/flatforge/assembly.py`, `backend/flatforge/api.py` |
| Geometry and browser regression | `tests/assembly.test.mjs`, `assembly-placement.mjs`, `assembly.browser.mjs` |
| CAD regression and browser fixtures | `backend/tests/test_assembly_cad.py`, `serve_assembly.py`, `verify_assembly_export.py` |
| Implementation report | `docs/assembly-spacing.md` |
