# STEP 6: selected CAD faces, gaps and local alignment

## What changed

The former “faces” were six global bounding-envelope sides. Those controls
could enforce directional support-plane clearances, but could not identify an
actual flange, align its normal, or separate a face gap from sliding alignment.
They remain available for existing layouts; saved configurations are not
automatically converted.

Each non-root entry now has **Connect actual CAD faces**. Choose an earlier
reference entry A, click a planar face on A at the desired connection point,
then click a planar face on moving entry B. Selected faces are blue/orange.
Local U/V/N arrows originate at A's picked anchor. Picking through another panel,
ambiguous boundary clicks and curved-face connections are rejected explicitly.
Orbit, pan, zoom and fit remain available; dragging is not a face click.

The editor provides a nonnegative gap, signed U/V offsets, signed normal
adjustment and in-plane rotation. It previews the entire dependent branch.
**Apply position** saves only after the latest exact CAD check passes.
**Cancel** restores the saved layout. **Reset alignment** clears offsets and
twist while retaining gap. **Reselect both faces** explicitly restores a temporary
envelope preview for picking, including recovery from stale face identities.
Incomplete or invalid numbers retain the last valid preview and block Apply.
Exports are disabled while a draft is open. The existing navigation guard also
protects unsaved assembly drafts.

## Geometry and shared transformations

`POST /projects/{id}/assembly/faces` returns original BREP face identifiers,
surface type, oriented normal, local frame, and picking tessellations in mm.
Face IDs are paired with a SHA-256 digest of the immutable source STEP. Anchors
are source-local coordinates. Rebuilt sources require explicit reselection;
there is no nearest-face guessing or topology-index reassignment.

Planar faces use V as the projection of the source panel's +Z onto the plane.
When parallel to Z, +Y supplies the up reference. U = V × N. The entire frame
rotates with A's assembly transformation. These are face-local directions,
not screen coordinates or blindly applied world X/Y/Z offsets.

The solver validates anchors on the original trimmed faces, including holes,
within 0.001 mm picking tolerance. It removes only verified picking roundoff
normal to the plane. B's selected normal is aligned opposite A's normal, its V
axis is aligned to A's V at zero twist, and optional twist rotates B about N.
All rotations are proper rigid rotations; scale, reflection and deformation
are forbidden.

For A's world anchor `a`, B's source anchor `b`, reference basis `(U,V,N)` and
solved B rotation `R`, the translation is:

```text
t = a + U * offsetU + V * offsetV + N * (gap + normalOffset) - R * b
```

U/V movement therefore preserves the normal gap. Normal adjustment explicitly
changes effective separation, which must remain nonnegative. Validation checks
the requested frame rotation, all three anchor displacements, and the exact
distance between the transformed **trimmed BREP faces**. If offsets remove
their projected overlap, the actual surface distance exceeds the plane gap:
the application reports both distances and blocks Apply/export. It does not
claim an exact shortest clearance between every surface of the two solids.

`POST /projects/{id}/assembly/place` is authoritative for all live placements,
including compatible envelope layouts. Entries are evaluated in dependency
order. Each child uses its reference's final matrix; moving an upstream entry
updates descendants without moving unrelated branches. Duplicate identities,
cycles, missing parents and forward references are rejected. Each moving panel
has one parent; closed constraint loops and multi-parent mates are unsupported.

The viewer applies returned matrices to existing GLBs, converting **only** mm
translations to metres. Validation signs the exact matrices and source hashes.
STEP export uses those signed matrices with the existing original CAD solids;
it does not tessellate or fuse parts. Selection helpers are outside panel groups
and are excluded from both STEP and GLB exports.

All panel pairs retain the existing exact common-volume collision checks.
Contact without positive solid volume is allowed. Collisions or conflicting
clearances block approval without automatically rearranging unrelated panels.

## Scope and limitations

- Supports planar trimmed connection faces, including irregular outlines and
  holes, unequal panel sizes, arbitrary source/reference orientations, in-plane
  twist, repeated panel instances and dependent connection trees.
- Curved/nonplanar connection surfaces require a planar reference face. A pair
  that must remain nonparallel cannot express a constant face gap with this
  mate. B is explicitly rotated into opposing planar alignment.
- Excessive tangential offsets that remove projected face overlap are rejected.
  A valid face gap can still conflict with other folded surfaces; exact solid
  validation remains mandatory.
- Existing browser-local, per-project assembly persistence is retained with
  optional face-connection data. No new database schema or cross-device sync is
  introduced. Source panel data, historical reviews and individual CAD solids
  are untouched.
- Actual face selection/validation requires the Python CAD service. Offline
  samples retain envelope placement only. Deploy frontend and backend together.
- Picking meshes assist interaction; engineering checks use BREP geometry.
  Browser verification used Chromium, including a narrow mobile viewport.
  FreeCAD GUI testing and universal CAD/surface support are not claimed.

## Changed files

| Area | Files |
| --- | --- |
| Face references, frames and placement | `backend/flatforge/assembly_connections.py` |
| CAD APIs, validation and shared export | `backend/flatforge/assembly.py`, `api.py` |
| Viewer, picking and connection editor | `components/flatforge/AssemblyViewer.tsx`, `assembly-face-picker.ts`, `AssemblyConnectionEditor.tsx` |
| Drafts, requests, persistence and integration | `face-connection-state.ts`, `assembly-cad.ts`, `assembly-storage.ts`, `types.ts`, `FlatForge.tsx` |
| STEP 6 styling and compatibility documentation | `app/globals.css`, `assembly-geometry.ts` comment, `docs/assembly-spacing.md` |
| Regression tests | `backend/tests/test_face_connections.py`, `tests/face-connection.test.mjs`, `tests/face-connection.browser.mjs` |

No STEP 2–5 geometry generation, engineering calculations or individual export
implementation was changed.

## Verification

Executed on 2026-10-27:

- 46 Node tests passed, covering draft validation, storage, stale-reference
  recovery, existing envelope placements, review, viewer and route helpers.
- 24 Python tests passed across face connections, legacy assembly CAD,
  project isolation, upload/review/rebuild/persistence and individual export.
- CAD tests measured a 20 mm gap with a +50 mm local V shift; also tested signed
  U/V offsets, positive/negative normal adjustments, contact, twist, angled
  source faces, irregular outlines/cutouts, unequal dimensions, rotated roots,
  descendant updates, fixed unrelated branches, stale references, invalid
  anchors/holes, curved-face rejection, collisions, invalid matrices and cycles.
- The legacy real-API/WebGL assembly suite passed, including six measured gaps,
  combined directions, rotations, legacy storage, collisions, source recovery,
  delayed validation, interactions and five downloaded STEP roundtrips.
- The new real-API/WebGL face suite exercised actual geometric face clicks,
  highlights, Apply/Cancel, independent offsets, invalid input, lost-overlap
  rejection, draft export blocking, navigation protection, persistence, mobile
  layout and stale-face reselection. Downloaded face-connected STEP/GLB files
  were compared against shared matrices. STEP was opened with CadQuery/OpenCascade
  to verify valid solids, counts, placed bounds, volumes and analytic face types.
- TypeScript checking and the production build passed. Focused assembly-module
  ESLint passed. `FlatForge.tsx` retains its three pre-existing set-state-in-effect
  errors and five image warnings, confirmed against the parent commit; no clean
  whole-project lint result is claimed. Build output retains Vinext's bundle-size
  warning and route-classification notice.
- The existing drawing-navigation browser suite passed: project/drawing CRUD,
  drawing isolation, Steps 1–5, refresh/direct URLs/back/forward, unsaved guards,
  stale review/log handling, and project-wide multi-panel views.

Commands:

```sh
node --experimental-strip-types --test tests/*.test.mjs
npx tsc --noEmit
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest -q \
  backend/tests/test_face_connections.py backend/tests/test_assembly_cad.py \
  backend/tests/test_project_context.py \
  backend/tests/test_workflow.py::test_upload_review_worker_exports_and_persistence \
  backend/tests/test_bend_editor_workflow.py
node tests/assembly.browser.mjs
node tests/face-connection.browser.mjs
npm run build
```

Browser suites require Playwright and Chromium (external installations can use
`PLAYWRIGHT_MODULE` and `FLATFORGE_CHROMIUM`) and run sequentially. They start a
disposable real Python API from bundled sample artifacts; CAD responses are not
mocked. Generated STEP files are re-imported with the same CAD kernel used by
the application, not reconstructed from meshes.
