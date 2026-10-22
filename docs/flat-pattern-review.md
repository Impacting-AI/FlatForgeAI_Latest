# Geometry-linked bend annotations in Extract & Review

The flat-pattern viewer displays each physical hinge's bend IDs, parent and child
face names, signed rotation, inside radius and deduction. Leader lines terminate
on the actual hinge boundary. Selecting a line or callout highlights that hinge
and its two face regions. Turn off **All bend values** for compact ID labels;
the selected bend's values remain visible below the drawing. Existing zoom
controls apply to geometry and annotations together.

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
parameter-default, or export policy is changed. The remaining Step 3 sections
retain their existing controls and layout.

Existing uploaded panels need one **Save & rebuild panel** after restarting the
updated API/worker and frontend. The original drawing remains visible until the
new geometry is available, with an explicit rebuild message. Bundled sample
extractions have been regenerated from their DXFs; their bend identities were
checked against the existing reports.

## Focused verification

```bash
node --experimental-strip-types --test tests/flat-pattern.test.mjs
PYTHONPATH=backend OPENBLAS_NUM_THREADS=1 python -m pytest backend/tests/test_flat_review_geometry.py backend/tests/test_complex_geometry.py::test_arbitrary_axis_solid_sections_unfold_and_step -q
node node_modules/typescript/bin/tsc --noEmit
```

The checks cover repeated source IDs, rotated axes, exact shared face boundaries,
unresolved angles, live value precedence, oblique deduction and callout placement.
