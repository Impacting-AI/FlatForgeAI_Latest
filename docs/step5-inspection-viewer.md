# STEP 5 engineering inspection appearance

This change is limited to the individual drawing's STEP 5 viewer. The project
comparison viewer and STEP 6 assembly keep their existing appearance and behavior.

## What changed

Previously, both imported `_paint` materials and the animated fold preview used
green surfaces. The viewer had strong tinted lights, a prominent grid, and no
feature-edge layer. Raw mesh wireframe was the only line-based inspection mode.

STEP 5 now uses neutral silver-grey `MeshStandardMaterial` surfaces with moderate
metalness (0.28), roughness (0.62), neutral hemisphere/directional lights and ACES
tone mapping. Illumination from above, sides and below makes surfaces readable
when the camera moves around the panel. There are no shadow maps, reflections,
post-processing passes, external textures or new dependencies.

The existing painted-face option remains available as **Distinguish painted
face**, using a subtle lighter grey for source-tagged surfaces. An untagged
single-mesh result stays neutral; the viewer does not invent painted-face tags.

## Feature edges and geometry integrity

The final folded model receives one cached, depth-tested line layer. It is built
from a temporary position-only copy of the existing mesh triangles, transformed
into the panel's coordinate system. Mesh/material splits are combined before
extracting edges, so a coplanar material boundary does not create a triangle seam.
Extraction works in millimetres to avoid rounding away small relief details in
metre-based GLBs. Source positions, normals, indices, transforms and scale remain
unchanged.

The overlay uses mesh boundaries and sharp adjacent-surface changes at a 30°
threshold. Coplanar triangle diagonals and small-angle tessellation facets are
suppressed. Smooth tangent bend transitions remain visible through shading;
their CAD topology is not reconstructed or guessed. These are filtered mesh
feature lines, not a replacement for BREP edge data or dimensional inspection.
The existing optional wireframe is explicitly labelled **Wireframe (mesh
triangles)** and remains off by default.

Rigid faces in the motion preview have their own cached outlines, which follow
the existing fold transforms. Animated bend surfaces keep the existing motion
geometry and use neutral shading. At full fold, the original exported mesh is
displayed with its complete feature overlay. No fold formula was changed.

Lines do not intercept hover raycasts. They use normal depth testing rather than
showing hidden geometry through the panel. Line buffers are disposed with the
viewer. Appearance changes and camera movement reuse the existing canvas and
buffers. The software fallback remains a simplified neutral surface preview;
the feature-edge overlay and physically based lighting require WebGL.

STEP/STL generation, panel dimensions, bend calculations, saved review state and
backend files are untouched. PNG snapshots capture the updated viewer appearance.

## Changed files

- `components/flatforge/inspection-presentation.ts`: display materials, lighting,
  cached edge construction and appearance updates.
- `components/flatforge/ModelViewer.tsx`: opt-in STEP 5 presentation, motion-preview
  outlines and resource cleanup.
- `components/flatforge/FlatForge.tsx`: STEP 5 opt-in and clearer display labels.
- `app/globals.css`: STEP 5-only neutral legend marker.
- `tests/inspection-presentation.test.mjs`: edge and geometry-integrity regression.
- `tests/inspection-viewer.browser.mjs`: browser inspection and export regression.

## Verification

Executed on 2026-10-26:

- **42 Node tests passed**, including seven new inspection tests and existing
  assembly, bend-review and route tests.
- TypeScript passed. ESLint passed for the new presentation module. The existing
  `ModelViewer` loading effect still triggers its pre-existing
  `react-hooks/set-state-in-effect` rule; full-repository lint is not claimed.
- Real folded fixtures retained every geometry buffer and transform. Tests also
  covered a rotated 0.05 mm-thick model, an untagged single mesh, a circular hole,
  an open corner notch, coplanar triangles split across meshes, and a smooth
  cylinder without false tessellation spokes or stripes.
- The STEP 5 browser suite passed with real WebGL and three existing folded
  panel GLBs. It checked neutral rendered pixels, surface/line draws, isometric,
  top/front/side views, flat/partial/folded states, animation, paint distinction,
  wireframe, bend hover, zoom/pan/orbit, PNG output, mobile layout, unchanged
  project comparison and the software fallback. Camera movements uploaded no
  new geometry buffers. STEP/STL export responses and all source artifacts were
  byte-for-byte identical to the originals. The browser issued no data writes.
- The drawing-workflow browser regression passed: project/drawing routing,
  selected-drawing Steps 1–5, CRUD, review/measurement requests, refresh and
  back/forward navigation, unsaved-work guards and project-level multi-panel
  views. The production build passed with the existing bundle-size warning and
  Vinext route-classification notice.
- One measured Node run built the three fixture overlays in approximately
  **18–36 ms each**. A **180,000-triangle** subdivided surface produced only its
  1,200 perimeter segments in **903 ms**, once. Each final panel adds one line
  draw; there is no edge extraction during camera movement. These are local setup
  timings, not a cross-device frame-rate guarantee.

Reproduce with:

```sh
node --experimental-strip-types --test tests/*.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint components/flatforge/inspection-presentation.ts
node tests/inspection-viewer.browser.mjs
node tests/drawing-workflow.browser.mjs
pnpm build
```

Browser tests accept `PLAYWRIGHT_MODULE`, `FLATFORGE_CHROMIUM` and
`FLATFORGE_QA_OUTPUT` when those tools are installed outside the repository. Run
the browser suites sequentially. This is a frontend update; it does not require
a CAD rebuild, new backend dependencies or a database migration.
