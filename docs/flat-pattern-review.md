# Geometry-linked bend annotations in Extract & Review

The flat-pattern viewer displays each physical hinge's bend IDs, parent and child
face names, signed rotation, inside radius, deduction and source section / vertex. Leader lines terminate
on the actual hinge boundary. Selecting a line or callout highlights that hinge
and its two face regions. Turn off **All bend values** for compact ID labels;
the selected bend's values remain visible below the drawing. Existing zoom
controls apply to geometry and annotations together.

Click a callout or the corresponding hinge line to open a compact editor inside
the drawing viewport. Bend IDs and face relationships are read-only. **Apply**
updates the shared review state; **Cancel** or Escape discards the local draft.
**Use automatic** clears only that bend's overrides.
The editor stays within the viewport during zoom/pan and on small screens.

The editor and quick-angle buttons use the same
`changeBend`/`updateBendParameters` update path. They share input-value resolution
and `bendValueError` with the existing Save & rebuild validation. Unchanged
automatic values are not promoted to manual overrides. Numeric precision is
preserved; empty fields are distinct from zero. Apply requires all three inputs,
a finite nonzero angle strictly between −180° and 180°, radius above 0 and at
most 100 mm, and deduction from 0 to 100 mm. Full allowance, material-model and
solid-geometry checks remain in the existing backend rebuild workflow.

Changes from panel parameters or quick-angle controls refresh the open editor,
discarding stale local drafts for that bend. Edits stay in the existing `bend_parameters`
state and use the unchanged review API and saved-review format. **Save & rebuild
panel** persists them and generates the updated solid. Apply alone does not save
to the server or rebuild the 3D model. Ambiguous identities, missing face links,
and unavailable hinge segments cannot be edited through the viewer.

Values follow the current panel settings and individual-bend review fields,
including unsaved edits. Saving and rebuilding remains necessary to update the
solid. Unknown angles stay **Not established**. A removed manual angle waits for
fresh detection rather than displaying the old confirmed value. Missing panel
parameters remain marked for review.

In the material model, deduction is explicitly labelled **90°** because that is
the calibration value entered in the controls. For an oblique bend, a second line
shows the deduction at its current rotation, calculated from the same allowance
formula as the backend. Fixed-deduction mode displays the per-bend value directly.

## Geometry contract

`extraction.json` version 2 adds the flat outline, material face polygons and
interior label points, and hinge boundary segments keyed by the existing review
key. These coordinates come from the same partition used for the fold tree.
Source DXF IDs alone are insufficient: one source line can bound separate flange
tabs. The viewer matches review key, source IDs and parent/child IDs and anchors
each callout on a real segment, not on the midpoint of the whole source line or a
face bounding box. Both geometry and labels use one aspect-preserving projection.

This data is emitted before section-value validation, so panels with unknown
angles can still be reviewed. No folding, extraction interpretation, tolerance,
parameter-default, or export policy is changed.

## Source references and Step 3 cleanup

Source references come from the matched report bend's `source` entries. Section
identifiers and vertex indices are displayed unchanged; repeated references are
deduplicated. A vertex index of zero is valid. Missing vertices are explicitly
unavailable, `USER CONFIRMED` is identified as having no extracted vertex, and
unresolved rotations with source evidence show an unresolved mapping status.
Pending manual edits do not rewrite extracted provenance. Callouts show a compact
two-line source preview; selecting the bend exposes every full reference in the
read-only editor and the selected-bend details. Long identifiers wrap. Apply and
Cancel remain visible while long editor content scrolls.

The redundant bend information and individual-bend editing tables are removed.
`review-state.ts` owns saved-state hydration and the review type; `bend-review.ts`
owns shared updates, input resolution and validation. The viewer remains connected
to the existing review API, including legacy saved bend angles.

The material-default checkbox is hidden only in Step 3. Its backend flag is
meaningful: when enabled, missing thickness/deduction use configured defaults;
when disabled, they need confirmation unless already reviewed. Drawing values
still take priority and conflicting/invalid drawing values still need review.
The configured inside radius continues without confirmation. Each panel's saved
`use_material_defaults` setting survives unchanged, and the existing global
Material defaults dialog still controls future uploads. Step 3 retains per-field
correction/confirmation without the generic helper paragraphs below the fields.

`CornerReliefControls.tsx` retains the adjustment UI behind the internal
`SHOW_CORNER_RELIEF_CONTROLS = false` switch in `ReviewControls.tsx`. It is not
rendered or interactive. Saved relief radii, notes, approval flags, backend
validation and export behavior remain intact. Necessary corner-region approval
controls remain visible when applicable.

The separate reviewed-bend checkbox, its explanation/note field and the warning
paragraphs below it are removed from Step 3. Reports and their warnings remain
intact. When section/finish evidence is missing or unreliable, applying an angle
in the viewer (including confirming its displayed value) enables the existing
reviewed-section recovery mode. Known rotations are retained; unknown and
deliberately cleared rotations stay unresolved. Radius/deduction changes alone
in shared state do not enable recovery, and geometry, collision, material and
relief errors cannot be classified as section failures. **Use automatic** clears
only that bend's overrides and returns processing to drawing-based section checks.

Bend-review notes are optional in the API, engine and frontend. Existing notes
are retained without manufacturing a source description. Saved corner-cut notes
and the backend requirement for approved corner-cut provenance remain unchanged;
their note editor stays with the temporarily hidden corner controls. The report
still identifies reviewed-section builds and the checks they could not perform.

The saved-review upload component and its exclusive handler/types are deleted.
The shared review API, stored overrides, project data, backend review-file utility
and rebuild support script remain available. No historical data is deleted.

Existing uploaded panels need one **Save & rebuild panel** after restarting the
updated API/worker and frontend. The original drawing remains visible until the
new geometry is available, with an explicit rebuild message. Bundled sample
extractions have been regenerated from their DXFs; their bend identities were
checked against the existing reports.

## Focused verification

```bash
node --experimental-strip-types --test tests/flat-pattern.test.mjs
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest backend/tests/test_flat_review_geometry.py backend/tests/test_complex_geometry.py::test_arbitrary_axis_solid_sections_unfold_and_step -q
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest backend/tests/test_bend_editor_workflow.py backend/tests/test_review_import.py -q
node node_modules/typescript/bin/tsc --noEmit
```

The checks cover repeated source IDs, rotated axes, exact shared face boundaries,
unresolved angles, live value precedence, oblique deduction and callout placement.
The edit workflow check saves all three parameters through the real review API,
rebuilds and re-imports STEP, measures cylinder radii, checks the fold-table
allowance, previews saved-review import, and clears one bend independently.


Browser checks (install Playwright/Chromium in your test environment):

```bash
node tests/step3-review.browser.mjs
```

The script starts Vite locally. Optional environment variables are
`FLATFORGE_TEST_URL` (reuse a running frontend), `PLAYWRIGHT_MODULE` (module path),
`FLATFORGE_CHROMIUM` (browser executable), and `FLATFORGE_QA_OUTPUT` (screenshots
and server log). It checks all 53 reference hinges, missing/unresolved sources,
read-only references, editing, invalid inputs, independent repeated IDs, shared
state updates, restored saved values, hidden relief preservation, both saved
material-fallback settings, removed controls, global defaults, zoom/pan and mobile
editor bounds. API transport is mocked here; the pytest workflow tests execute
the real review API, CAD rebuild, STEP re-import and corner-relief export.
