# STEP 6: side connections, independent positioning and project saves

This update supersedes the connection-locking, clash enforcement and browser-only
persistence behavior described in `assembly-workspace.md`.

## What changed and why

The old Move action changed mate parameters and moved descendants through the
connection tree. The root also moved the whole assembly. Subsequent solves could
therefore restore a panel's connection-derived placement rather than its intended
individual position. STEP 6 now snapshots source-pinned rigid placements. **Move**
changes only the selected panel; **Move branch** deliberately applies a translation
to its descendants. Connections retain their original side, face references and
gap as provenance, but do not remain locked constraints after placement.

The viewport uses STEP 5's shared aluminum material, lighting, tone mapping, grid
and cached geometric feature-edge rendering. Mesh triangulation remains available
only through the explicitly labelled wireframe inspection option. Overlap does not
change panel colors. Selection and painted-face inspection remain available.

Connection controls expose Left, Right, Top and Bottom. The CAD service establishes
a source-local panel frame from its dominant planar surface, finds outward planar
regions at each side's geometric extent, and uses anchors on the actual trimmed
BREP faces. Coplanar candidate patches share a connection plane; the largest is
selected deterministically. Nonparallel alternatives require a click on a
highlighted region in the viewer. There is no separate CAD-face dropdown.

STEP 6 explicitly requests the free-placement policy. It permits intentional
intersection, contact and signed manual offsets. It still rejects malformed trees,
non-finite values, non-rigid transforms, stale source geometry and inconsistent
placement data. The shared constrained-policy CAD validation remains available and
unchanged for existing callers. No panel geometry is deformed or fused.

## Workflow

1. Select First Panel, then Add Panel and choose the reference and two sides.
2. Review the initial gap and Connect.
3. Select any panel and Move. Drag the controller or enter exact millimetres.
   UI X = CAD world X; UI Y = CAD world Z (up); UI Z = CAD world −Y (forward).
   These world directions are displayed in the editor. Signed offsets are relative
   to the panel's initial frozen placement, not a claim of current face clearance.
4. Apply position commits the working edit; Cancel or Reset restores the start of
   that edit. Undo/Redo remain available. Move branch is a separate action.
5. Save Assembly stores the entire working layout with the project. Export STEP
   uses the same final matrices, including manual offsets and overlapping solids.

## Saving and rollout

Deploy the frontend **and** restart the updated Python API. Its existing database
initialization adds `project_assemblies` without deleting project/drawing data.
There is one saved assembly per project, updated with a revision compare-and-swap.
Repeated saves do not create duplicate assemblies. Concurrent edits produce an
error and retain local changes; Reload saved assembly requires explicit discard
confirmation when needed. Navigation and browser unload use the existing unsaved
work guard. Save never reruns the placement solver or modifies panel geometry.

GET/PUT `/projects/{projectId}/assembly` reuse existing authentication and project
storage. Nonempty saves consume a signed approval of the current rigid placement,
so incomplete or stale matrices cannot be saved. STEP export consumes the same
approval and original CAD solids. Source hashes and drawing revisions pin geometry.

Existing browser-only layouts are recovered only when no server save exists and
are not deleted. Click Save Assembly to persist a recovered layout to the project.
Visibility is an inspection preference: hidden panels still participate in export.
Labels, gizmos, edge overlays and measurement controls are not CAD export geometry.

## Main files

- `AssemblyWorkspace.tsx`, `AssemblyConnectionEditor.tsx`, `assembly-gizmo.ts`:
  side workflow, independent moves, contextual controls and explicit branch moves.
- `assembly-workspace-state.ts`, `assembly-cad.ts`, `types.ts`: shared pose data.
- `useProjectAssembly.ts`, `assembly_projects.py`, `db.py`, `api.py`: project saves,
  revision conflicts, reload and legacy browser recovery.
- `AssemblyViewer.tsx`, `inspection-presentation.ts`, `ModelViewer.tsx`: shared
  rendering configuration and meaningful feature edges, no clash presentation.
- `assembly.py`, `assembly_connections.py`: side classification, source-pinned rigid
  poses, policy-scoped validation and CAD STEP export.

## Limits

Curved connection surfaces and solids without a unique main panel plane are not
silently approximated as planar side mates. Unsupported sides explain the limitation;
ambiguous planar regions require a visual selection. Side names follow the source
panel frame, not screen directions after orbiting. The original gap describes the
initial connection; independent normal movement deliberately changes that clearance.
Free placement does not certify collision-free manufacture. Mesh feature edges are
geometric inspection aids, not an exhaustive BREP topology overlay. Existing normal-
axis rotation remains available; this update does not add a new arbitrary-rotation tool.

## Verification

Executed checks on this change:

- 52 Node tests passed, including independent/root/branch movements, retained poses,
  existing review logic, feature edges and geometry-buffer preservation.
- 32 distinct Python tests passed across assembly/face/project-context, the seven
  free-placement/save tests, and the existing upload/review/solid-generation tests.
- Real-CAD assembly browser checks passed: four-side connections, pointer dragging,
  signed exact offsets, individual and explicit branch moves, intentional full
  overlap, save/reload without browser storage, revision conflicts, navigation
  guards, hidden-panel export, desktop/mobile and export/source failure recovery.
- Legacy browser-layout recovery passed with retained rotations, signed offsets,
  project isolation and exact STEP/GLB placements.
- Drawing-workflow browser regression passed: project CRUD, drawing-scoped Steps
  1–5, direct URLs, back/forward, refresh and unsaved-change guards.
- STEP 5 browser regression passed on rerun after adjusting its software-fallback
  screenshot capture: three panel fixtures, camera controls, feature-edge rendering,
  animation, hover, cached buffers, mobile, software fallback and byte-identical
  STEP/STL downloads. No application workaround was needed for the capture timeout.
- TypeScript, focused assembly-module ESLint and the production build passed.
  The build retains its existing bundle-size/static-route-classification notices;
  Python reports a Starlette/httpx deprecation warning.

Browser coverage uses real folded panel STEP/GLB fixtures and the Python CAD API; export verification
reopens the generated STEP using OpenCascade/CadQuery and compares solid geometry
and transformations. No interactive FreeCAD session is claimed.
