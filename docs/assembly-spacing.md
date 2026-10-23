# STEP 6 assembly spacing

## Units and the corrected defect

The backend accepts millimetre DXFs (`$INSUNITS=4`) and unitless DXFs under the
workspace's documented mm convention. Other declared units require review;
assembly does not reinterpret them. CadQuery solids and STEP exports use mm.
STL has no unit declaration; FlatForge writes its CAD coordinates in mm.

Both backend GLB exporters already multiply tessellated CAD coordinates by
0.001. AssemblyViewer previously applied another `scale.setScalar(.001)` to
the loaded GLB, while correctly dividing gap inputs by 1000. This shrank panel
dimensions by 1000 relative to the gap. The extra scale is removed. The loaded
GLB and all original node transforms remain unchanged inside a translation-only
wrapper. Only mm inputs are converted to metres for Three.js placement.

Measured GLB envelopes agree with the supplied reports (within 0.002 mm):

| Fixture | X × Y × Z, mm |
| --- | --- |
| 1570 | 2034 × 670 × 358 |
| 1619 | 2034 × 654 × 320 |
| 1648 | 990 × 2917 × 55 |

## Control semantics

The existing viewer and face picker are **Z-up**, so the three inputs are:

- Horizontal (X): + right / − left.
- Vertical (Z): + up / − down.
- Front / back (Y): − front / + back.

The axis of the selected target face uses the existing non-negative connection
gap. For opposing faces, it is the separation between their axis-aligned bounding
planes, measured along the target face's outward normal. The other two inputs
are signed offsets from that face-connected placement. Changing the selected
target face relabels the controls: the gap follows the new connection direction;
any offset on that new gap axis resets to zero to avoid a hidden second spacing.
Unchanged tangent offsets remain in place. Reset restores 10 mm gap and zero
offsets. Choosing Top/Bottom stacks panels; choosing Front/Back arranges depth.

A 10 mm gap between overlapping parallel planar faces is a 10 mm physical
clearance. For folded, non-overlapping or rotated surfaces this is **bounding-plane
separation**, not a claim about the exact shortest distance between solids.
Non-opposing face pairs retain the existing placement behavior and explicitly
show “connection offset” instead of claiming a gap. Panels are never auto-rotated.

`assemblyPlacements` is the shared placement calculation. It uses actual GLB
vertex bounds including node transforms. The root is centered at XY origin with
its bottom at Z=0. Lateral connections keep bottom alignment relative to their
target; offsets then translate only that panel and its connected descendants.
Vertical connections use face centers. Unrelated branches do not move. Broken
references, cycles and invalid numbers fail explicitly. Removing a panel removes
its connected descendants to avoid orphaned references.

## State, viewing and export

- Spacing and connection edits update existing Three.js groups; the camera,
  orbit, pan and zoom are preserved. Model revisions reload geometry.
- Empty, negative-gap and non-finite input is rejected; the last valid value
  remains applied, with a visible message. Signed tangent offsets accept negatives.
- Versioned `flatforge.assemblies.v1` browser storage records each project's
  ordered entries in mm, including gap, offsets and face relationships. Reloading
  and switching projects restores them. Legacy gap-only entries imply zero offsets.
- This is browser-local persistence, not server or cross-device synchronization.
  Unreadable stored data is preserved and a session-only warning is shown.
- **Export assembly GLB** clones the exact positioned panel groups in assembly
  order, excludes lights/grid/clash overlays, and writes standard metre GLB
  coordinates. Scene extras retain the connection settings in mm and wrapper
  extras identify each assembly entry and source panel. Screenshot also uses the
  current assembly scene.
- Existing STEP/STL and project ZIP exports remain individual panel artifacts.
  There was no assembled STEP/STL exporter; this change does not imply one exists.
- Backend engineering calculations, individual geometry, and Steps 1–5 are unchanged.

## Verification

Run from the repository root:

```sh
node --experimental-strip-types --test tests/assembly.test.mjs tests/flat-pattern.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint components/flatforge/AssemblyViewer.tsx components/flatforge/AssemblySpacing.tsx components/flatforge/assembly-geometry.ts components/flatforge/assembly-storage.ts components/flatforge/useAssemblyState.ts
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest backend/tests/test_panel_regressions.py backend/tests/test_bend_editor_workflow.py -q
node tests/assembly.browser.mjs
node tests/step3-review.browser.mjs
```

Browser tests require Playwright and Chromium. Set `PLAYWRIGHT_MODULE` and
`FLATFORGE_CHROMIUM` for an external installation, and optionally
`FLATFORGE_QA_OUTPUT` for screenshots/exported GLBs. The assembly test runs a real
WebGL renderer with SwiftShader, exports and reloads GLBs, then measures their
coordinates. API bootstrap uses bundled sample records; no external service is
required. CAD tests use the real Python engine.

Coverage includes 1/5/10/25/50/100 mm gaps, all six connection directions,
different panel dimensions, rotated nodes, repeated models, offset combinations,
raised descendants, invalid input, reset, browser reload, project isolation,
clash checking, viewport interactions and mobile controls. Original customer-DXF
regressions skip when the seven external fixtures are unavailable; the three
bundled folded-panel regressions still execute.

Executed for this change: 27 Node tests passed (9 assembly, 18 flat-pattern),
both browser suites passed, TypeScript and focused assembly lint passed, and
`pnpm build` completed. The selected Python suites reported 5 passed and 7
skipped because the external customer DXFs were absent. The existing
`FlatForge.tsx` lint baseline remains 7 errors / 10 warnings; whole-project lint
is not claimed to pass.
