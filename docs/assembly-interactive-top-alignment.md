# STEP 6: viewer connections and initial top alignment

The two connection interfaces share `FaceDraft`, side-region resolution,
`previewFaceDraft`, occupied-side insertion, validation and Apply. They do not
have separate placement calculations.

## Viewer workflow

The toolbar Connect action starts a temporary selection mode. Click a first
(reference) L/R/T/B label, then a second panel's label. The contextual panel shows
both endpoints and Join Panels commits the validated preview. From/To buttons
allow replacing either endpoint; Cancel clears the draft. Selecting the same
panel twice or creating a graph cycle produces an explicit message.

Reference and moving badges have different outlines. Their existing colours,
text and geometric anchors are unchanged. In Connect mode side labels can be
selected through folded surfaces; normal inspection retains occlusion handling.
Selecting a panel body prioritizes its labels in a crowded view. Orbit, zoom and
pan continue to work. Ambiguous CAD regions or multiple occupied branches reuse
the existing clarification interface rather than silently selecting geometry.

## Initial top alignment

The previous CAD mate aligned its two selected face anchors, generally near the
face centres. That centred unequal-height panels. New left/right side connections
now request `alignTop` as part of their transient placement request. No saved
schema or existing model is migrated.

After the existing mate determines rotation and normal separation, the server
uses the same source-local main-plane frame as side identification. It transforms
the reference panel's up direction into the assembly, projects it into the
connection tangent plane, and measures the original folded BREP bounds in that
frame. The difference between the two top support coordinates becomes a
tangential connection offset. The normal gap and rotation remain unchanged.
For angled side faces, this is the connection's tangential top reference, not a
claim of matching world-Z extrema for every possible assembly.

Top/bottom connections bypass this adjustment. Old requests default to the old
behaviour. Applied poses and manually moved panels bypass initial alignment;
Save, reload and STEP export continue using those authoritative poses.

## Scope and limitations

The existing tree rules still apply: a panel cannot be reconnected to its own
descendant. Ambiguous/nonparallel insertion exits still require an explicit
connection choice. This update does not introduce a constraint solver, collision
restrictions or changes to panel solids. Dense/offscreen labels may require
selecting their panel, zooming or orbiting.

## Files

- `AssemblyWorkspace.tsx`: Connect mode, endpoint selection, shared drafts and
  responsive toolbar measurement.
- `AssemblyConnectionEditor.tsx`, `assembly-workspace-state.ts`: shared occupied
  side lookup for branch clarification in either interface.
- `AssemblyViewer.tsx`, `assembly-labels.ts`, `globals.css`: selection-mode labels
  and endpoint outlines.
- `assembly-cad.ts`, `assembly.py`: transient alignment request.
- `assembly_insertion.py`, `assembly_connections.py`: initial top adjustment before
  the existing occupied-side graph operation.
- `test_assembly_top_alignment.py`, `assembly-interactive.browser.mjs`: geometry
  and direct-interaction regression coverage.

## Verification

Executed checks:

- 57 Python tests passed across top alignment, insertion/reconnection, free
  positioning, CAD connections, STEP export and project isolation. Ten alignment
  cases cover equal/unequal heights, shifted origins, folded returns, arbitrary
  3D rotations, top/bottom mates and saved manual offsets.
- 57 JavaScript tests passed. TypeScript, focused ESLint and production build passed.
- The interactive browser suite used actual label clicks for all four side pairs,
  compared their matrices with dropdown results, rejected the same panel twice,
  replaced both endpoints, cancelled a partial selection, switched to Move,
  inserted through an occupied side, and saved/reloaded a manual offset.
- Existing insertion/reconnection and free-movement browser suites also passed,
  including mobile controls, popup dragging, independent/group moves, intentional
  overlaps, concurrent-save protection, save/reload and exact STEP/GLB output.
- Its STEP/GLB round trip confirmed three valid original CAD solids, retained
  face geometry/volume and exact final preview matrices.

CAD inspection used OpenCascade/CadQuery, not an interactive FreeCAD session.
