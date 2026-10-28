# STEP 6: occupied-side insertion and anchored annotations

This update builds on `assembly-free-positioning.md`. Independent Move, deliberate
overlaps, project saves and the original folded CAD solids remain unchanged.

## Root causes and changes

The prior Add workflow placed a new panel at the selected connection without
looking for an existing edge on that side. Existing frozen poses correctly
prevented automatic movement, but no explicit insertion operation updated them.
The new operation examines the connection graph and previews the affected branch
before Connect commits it.

The prior panel labels projected bounding-box corners and then clamped or shifted
labels in screen coordinates. Those shifts could detach a label from its model.
Labels now use actual triangle-interior anchors in panel-local coordinates,
transformed through the panel's current matrix. Visible surface candidates can be
selected as the camera changes. Occluded, clipped or crowded annotations hide
instead of floating away from their surface. Selected panels have priority, and
the panel list remains available when geometry is hidden or coincident.

Side labels use the same CAD-derived Left/Right/Top/Bottom regions as connections.
Their anchors are real edge midpoints on those regions, so thin sides remain
identifiable from an overhead view. Hover/select highlights the corresponding
region; ambiguous regions remain explicitly ambiguous. Names follow the source
panel frame, not the current camera orientation. Full picking meshes load lazily;
all-panel labels use a lightweight side-reference endpoint. Cached visible anchors
and bounded ray segments reduce repeated visibility work.

The old positioning popup was rewritten beside the gizmo every animation frame.
That automatic positioning has been removed. Existing information panels now have
a draggable header, pointer capture, workspace bounds, session-scoped positions
per project/panel type, resize clamping and a Reset popup position action. Inputs
and buttons do not initiate dragging. These preferences are separate from CAD data.

## Insertion geometry and graph rules

1. Determine whether the chosen source-local side is occupied by an outgoing or
   incoming saved connection. Multiple occupants require choosing a branch.
2. Place the new panel using the existing CAD-face solver and requested gap.
3. Resolve its opposite exit side from the actual folded BREP geometry. A unique
   exit plane with the existing connection's world normal is required to preserve
   the existing panels' rotations.
4. Remove the occupied edge temporarily. Traverse exactly the disconnected
   component on the displaced side; unrelated panels stay fixed.
5. Compute the displacement between the old reference anchor and new exit anchor.
   Translate that component's frozen base matrices and rotation pivots together.
   Preserve its manual offset vectors, rotations and original gap values.
6. Rewire reference → new panel → displaced panel. Topologically order and validate
   the graph. If inserting towards the old root, re-root traversal at the fixed
   reference panel and reverse the necessary links without renaming panel labels.
7. Return the same authoritative matrix data used by the preview, Save Assembly
   and original multi-solid STEP writer. Apply/Cancel and Undo/Redo remain intact.

This is an explicit insertion edit, not a permanent mate constraint or collision
solver. Later individual movement still affects only the selected panel. No clash
colors, automatic collision correction or global overlap restrictions are added.
Manual normal offsets may intentionally retain overlap; insertion does not erase
those decisions or claim a global shortest surface clearance.

## Supported cases and limitations

- Left, Right, Top and Bottom; unequal panels; rotated assemblies; planar folded
  connection regions; downstream branches; incoming edges; retained manual offsets.
- Multiple occupants require an explicit branch selection. Only that component moves.
- A nonparallel exit would require changing existing rotations, so it returns a
  clear conflict rather than silently doing so. Curved or ambiguous exit regions
  also require a different connection choice or manual positioning.
- Legacy envelope links without named sides must first be reconnected through the
  existing side workflow. Their source side is never guessed; Move remains available.
- Labels can hide when occluded, offscreen, or too crowded. Selecting a panel,
  orbiting or zooming exposes its labels without moving their anchors off the body.
- Popup positions are browser-session preferences, not exported or shared project
  geometry. The assembly graph and actual poses are saved to the project normally.

## Changed components

- `backend/flatforge/assembly_insertion.py`: occupied-edge traversal, geometry-based
  displacement, pose preservation and graph rewiring.
- `assembly.py`, `assembly_connections.py`, `api.py`: insertion preview input,
  authoritative placement reuse, boundary annotation points and lightweight sides.
- `AssemblyWorkspace.tsx`, `AssemblyConnectionEditor.tsx`, `assembly-cad.ts`,
  `face-connection-state.ts`: staged insertion, branch choice and shared result state.
- `assembly-labels.ts`, `assembly-face-picker.ts`, `AssemblyViewer.tsx`: anchored
  annotations, visibility, side highlighting and lazy CAD picking data.
- `useAssemblyPopupDrag.ts`, `app/globals.css`: bounded header dragging and styling.

## Verification

Executed verification:

- 42 Python tests passed across insertion, free positioning, CAD connections,
  assembly export and project isolation. Insertion cases cover all four directions,
  rotated/unequal panels, manual offsets, incoming edges, branch choices, ambiguous
  legacy links, nonparallel exits, save/load and STEP round trips.
- 55 JavaScript tests passed, including triangle-interior anchors for cutouts,
  nested transforms and degenerate geometry.
- The new real-CAD browser suite passed: B → D → C insertion, retained manual
  offsets, unchanged unrelated panels, independent movement after insertion,
  rotation, save/reload, exact STEP/GLB positions, projected surface anchors in
  isometric/top/front views, and bounded/reopened/reset popups on desktop/mobile.
  Export inspection confirmed four valid solids with preserved faces and volumes.
- TypeScript checking, focused assembly ESLint and the production build passed.
- The existing free-assembly browser suite passed with real Python CAD geometry:
  independent/root/branch movement, gizmo dragging, intentional overlap, saves,
  reload, concurrent-save protection, STEP/GLB matching and desktop/mobile views.

CAD round trips use OpenCascade/CadQuery; no interactive FreeCAD session is claimed.
The only Python warning was the existing Starlette/httpx deprecation warning.
