# STEP 6 interactive assembly workspace

This update replaces the disconnected envelope-add dialog and separate CAD-face
form with one viewer-centered workflow. It uses the existing planar CAD mate
solver, exact solid validation, and STEP exporter. Individual panel solids,
bend calculations, DXF extraction, and STEP 5 exports are unchanged.

## Workflow

1. **Select First Panel** lists approved project drawings with both GLB and STEP
   artifacts. The chosen instance becomes Panel A; the camera fits it.
2. **Add Panel** stages the next instance outside the actual assembly bounds.
   It is an unsaved preview, not an automatically accepted connection.
3. Choose any already-added reference panel. Hover/click its actual planar CAD
   face, then the moving panel's face. A face-list alternative exposes the same
   source CAD identities for narrow or occluded surfaces. Side names use
   source-local face normals, with the exact Face ID to disambiguate flanges.
   Picking a face on a reference panel first also leads directly into Add Panel.
4. Inspect the proposed alignment and measurements. **Connect Panels** is enabled
   only after both faces are selected, inputs are complete, and exact CAD checks
   pass. Cancel discards the staged panel.
5. Click a model or its label to select it. **Move** opens a local XYZ translation
   gizmo and an adjacent numeric editor. **Rotate** edits the existing in-plane
   twist about the mate normal. Apply commits; Cancel restores saved placement.
6. The panel list provides drawing names, reference relationships, visibility,
   painted-face distinction, mesh wireframe, and clearance checking. Visibility
   affects inspection only: all assembly parts remain in exports.
7. Export Assembly as STEP downloads original BREP solids at the verified shared
   transforms. GLB, screenshot, orbit, pan, zoom, fit, and standard views remain.

Labels are stable A…Z, AA…CV, independent of array position after removals. Existing
unlabelled layouts acquire labels without changing any engineering parameter.
Repeated drawing instances are available via **Include drawings already added**.
Removing a panel removes its dependent branch, with confirmation. Undo/Redo
retains up to 40 committed actions in this workspace session. Position controls
can collapse to a small live measurement readout on crowded/mobile views.

## Movement and accuracy

The backend now returns the existing solved mate's world-space orthonormal
frame and moving face anchor with `/assembly/place`. The viewer does not infer
the frame from a mesh bounding box or implement another mate solver.

| Control | Meaning for a face-connected panel |
| --- | --- |
| Connection gap | Base selected-face normal clearance in mm |
| Local X | Offset U, tangent to the reference face |
| Local Y | Offset V, tangent to the reference face |
| Local Z | Additional normal separation; explicitly changes the effective gap |
| Effective face gap | Connection gap + local Z offset |
| Rotation | Existing twist about the reference face normal |

The reference face frame is the existing CAD frame: local V projects source +Z
onto the plane (source +Y fallback), local U is V × normal. The frame rotates
with the reference panel. On a root, UI X/Y/Z means world X / world Z (up) /
world −Y (forward). The UI states this difference; world Z remains vertical.

A root's optional `rootOffset` is a rigid translation in world millimeters.
Legacy assemblies default to zero. Moving a root moves its entire connected
assembly; moving a child carries its descendants and leaves unrelated branches
fixed. Source dimensions, thickness, face topology and rotations are preserved.

Dragging uses the backend frame to translate the selected branch temporarily.
It does not alter source vertex buffers or recompute CAD mates in JavaScript.
Drag increments are 1 mm, or 0.1 mm with Shift; typed entries accept arbitrary
finite precision. Normal dragging stops at zero effective gap. Numeric entry
rejects negative effective gaps and incomplete/non-finite values.

Exact CAD placement and all-pair intersection checks run after release and after
numeric edits. During dragging and while checks are pending, Apply and exports
are blocked. A new layout invalidates prior approval tokens; late responses
cannot approve changed geometry. Conflicts stay as unsaved previews and show a
warning, with intersecting panels highlighted. Reset restores the saved position.
All helpers, labels and popups are outside the exported panel groups.

## Compatibility and limits

- Update/restart both frontend and Python service: the gizmo consumes the new
  frame response. No database migration or new dependency is required.
- Saved layouts remain browser-local and project-specific under the existing
  versioned storage key. Unknown/corrupt storage and unavailable panel sources
  are retained, not overwritten or exported partially. Refresh restores applied
  positions; unsaved previews use the existing navigation/unload guard. Undo
  history is session-local, not persisted across reloads.
- Existing envelope layouts retain their geometry and their original gap/offset
  editing controls in a contextual card. Selecting actual faces explicitly
  upgrades the chosen connection. No silent envelope-to-face conversion occurs.
- Planar faces on irregular, folded or rotated solids are supported. Curved
  constant-gap mates, nonparallel mates and closed constraint loops remain
  unsupported and are rejected. Existing connections may be reparented to an
  earlier entry; a newly added panel may choose any existing entry.
- Exact checks require overlap of the selected trimmed faces in projection.
  Large tangential shifts that lose that overlap are rejected, even if their
  infinite planes are separated. Face gap is not a promise about the shortest
  distance between unrelated surfaces elsewhere on either panel.
- CAD face IDs, source hashes and picked points remain authoritative. Source
  rebuilds require explicit reselection when hashes change. Face-list selection
  anchors at an actual nondegenerate triangle interior, not a face centroid
  that could lie in a hole. No filenames, sample sizes, normals or example gaps
  are used as panel-specific placement rules.
- Rotation uses the established precise twist field; a free three-axis rotation
  gizmo and touch-device performance guarantees are not introduced.

## Changed components

- `AssemblyWorkspace.tsx`: guided addition, selection, contextual actions,
  unsaved draft state, history, visibility and exact-value editing.
- `AssemblyConnectionEditor.tsx`, `AssemblySpacing.tsx`: contextual face editor
  and retained envelope controls, including incomplete-input blocking.
- `AssemblyViewer.tsx`: backend frames, controller lifecycle, camera views,
  model selection, shared placement and export gating.
- `assembly-gizmo.ts`, `assembly-labels.ts`, `assembly-face-picker.ts`: Three.js
  interaction and lightweight HTML annotations outside exported geometry.
- `assembly-workspace-state.ts`, `assembly-storage.ts`, `assembly-cad.ts`,
  `assembly-geometry.ts`, `types.ts`: labels, draft staging, branch selection,
  precision, backwards-compatible persistence, root translation and API types.
- `FlatForge.tsx`, `app/globals.css`: replace only the STEP 6 assembly forms with
  the contextual workspace and scoped responsive styling.
- `backend/flatforge/assembly.py`, `assembly_connections.py`: optional validated
  root translation and existing solved CAD frames in the placement response.

## Verification

Run the regression commands below from the repository root. Browser suites
start a disposable real Python CAD API and Chromium/WebGL; run them sequentially.
`PLAYWRIGHT_MODULE` and `FLATFORGE_CHROMIUM` can point at external installations.

```sh
node --experimental-strip-types --test tests/*.test.mjs
npx tsc --noEmit
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest -q \
  backend/tests/test_face_connections.py backend/tests/test_assembly_cad.py \
  backend/tests/test_project_context.py \
  backend/tests/test_workflow.py::test_upload_review_worker_exports_and_persistence \
  backend/tests/test_bend_editor_workflow.py
node tests/face-connection.browser.mjs
node tests/assembly.browser.mjs
node tests/drawing-workflow.browser.mjs
npm run build
```

Executed on 2026-10-27:

- **51 Node tests passed**: workspace labels, triangle anchors, staging, branch
  selection, precision, persistence/history, legacy geometry, STEP 3 review,
  STEP 5 presentation, and route helpers.
- **25 Python tests passed** (24 existing regression cases plus the new root/frame
  case): planar mates, signed offsets, angled/irregular source solids, holes,
  rotations, descendants and unrelated branches, collisions/contact, invalid
  sources/anchors/cycles, legacy placement, project isolation and individual
  upload/review/build/export persistence. The new case verifies orthonormal
  controller frames and root translations against actual placed CAD geometry.
- **Three browser suites passed** with Chromium: the interactive face workspace,
  legacy assembly regression, and project/drawing navigation. The first two use
  real folded fixtures and the real Python CAD API.
- The interactive suite clicked actual CAD faces, dragged a real Three.js handle,
  checked mm entry and a 20 mm gap with +50 mm tangent movement, blocked drafts,
  tested reset/undo/redo, numeric twist, three-panel parent/child propagation,
  root group movement, collision rejection/recovery, refresh, visibility,
  stale-face reselection, and desktop/mobile layouts. A focused browser timing
  check also held the CAD placement response and verified that stale gizmo
  handles could not change the pending exact input or enable Apply.
- Legacy browser checks measured 1/5/10/25/50/100 mm gaps, combined directions,
  different dimensions, preserved rotations and previous offsets, source failure,
  export retry, project isolation and delayed approval rejection.
- Browser-downloaded STEP files were reopened with CadQuery/OpenCascade and
  compared with the exported GLB's authoritative matrices: valid solid counts,
  placed bounds within 0.00001 mm, volumes and analytic surface types. Helpers
  were absent, and hidden inspection panels remained included. This is a CAD
  kernel roundtrip, not a claim of manual testing in FreeCAD.
- TypeScript and focused assembly-module ESLint passed. Production build passed
  with the existing Vinext bundle-size warning and route-classification notice.
  `FlatForge.tsx` retains two pre-existing effect lint errors and five image
  warnings (parent had three such errors and the same five warnings). A clean
  whole-project lint result is not claimed.

The production UI requires a current Python service for exact CAD positioning.
These tests do not establish universal compatibility for arbitrary curved mates,
large assemblies on all GPUs, or untested mobile touch devices.
