# Complex panel DXF diagnostic (25 September 2026)

Applies to the four supplied **PN_NM** files (the message called them PN_PM).
Their source drawings are not committed to this public repository.

## Findings

All four files contain KIFOF and CONTOR. Their section walls are on the
Hebrew **חיפוי** layer instead of HAT, with painted-face triangles in `Zeva`
INSERTs. All KIFOF entities participate in a connected fold tree after joint
noding of the axes: 135 has 21 axes/22 faces, 145 has 14/17, 148 has 19/22,
149 has 23/28. Several axes describe disconnected flange tabs, so a line is
not always identical to one physical bend. None of these counts establishes
the three-dimensional fold directions by itself.

| File | Original error | Drawing evidence and remaining constraint |
| --- | --- | --- |
| PN_NM_135 | Orthogonal axes only | Contains approximately 0.34° and 2.50° plan-axis deviations, as well as truly perpendicular axes. Four section profiles recovered; one matches a unique normal cut within 0.334 mm. The other three are projected details crossing axes that are not parallel; they cannot be treated as normal cross sections. |
| PN_NM_145 | Missing HAT | The HAT layer is empty, but two complete painted section profiles exist on חיפוי. One section matches exactly. The other has a 30.466° turn and its closest compatible cut has **1.922 mm** strip-length error using t=2, r=2, BD90=4. There is no reliable 90°-bend deduction to apply blindly at this turn. |
| PN_NM_148 | Unsupported CONTOR DIMENSION | CONTOR handle **AA** is an annotation, not cutting geometry; it is now excluded and reported. Angled axes include approximately 30.34° and 59.66° orientations. Four sections recovered; one includes two 60° turns, with the closest normal cut at **2.048 mm** error under the current material calibration. Two long views cross nonparallel axes; another normal view has 0.850 mm error. |
| PN_NM_149 | Orthogonal axes only | Contains the same angled end arrangement, with 23 axes creating 27 hinge edges. Four profiles recovered; the lower profile has one unique normal cut with 0.018 mm residual. The upper profile has **three distinct** geometrically equivalent candidate hinge chains; it has no unique source cut marker. The other two views cross nonparallel axes. |

## What changed

- Recognize the actual section-layer convention and read mirrored block markers
  in world coordinates; report both with entity provenance.
- Ignore documented annotation types on CONTOR while still rejecting unknown
  entities that could change material boundaries.
- Node angled hinge arrangements together, recover the underlying analytic
  support for BREP plate-to-bend joins, and preserve the established
  orthogonal construction path for older drawings.
- Support signed bends of arbitrary measured angle with constant K derived
  from the 90° calibration, and expose the actual axis/allowance in the 3D
  viewer and neutral-surface unfolding.
- Match a section only when the full face chain, all flat strip lengths, marker
  orientation, and every hinge's normal direction agree. Report numerical
  residuals and ambiguity otherwise. An ambiguous or projected section never
  supplies automatic signed angles or a downloadable STEP.

## Limitations and required evidence

All four customer examples currently remain **NEEDS_REVIEW**. None has a
validated, generated STEP from this change. Replacing the old exception with a
model made from guessed fold directions would be a regression in engineering
integrity. A general projected-section solver needs explicit cut-plane
positions/directions tied to each drawing view, measured angle/BD behaviour
for non-90° bends, and an independent folded reference for verification.
PN_NM_145 and PN_NM_148 additionally need the measured bend-parameter
convention reconciled with the dimension residuals above. A 100% accuracy
guarantee for *any* DXF is impossible when dimensions conflict or the section
to hinge correspondence is ambiguous.

The extraction SVG and `report.json` include the recovered face graph,
profile vertices and handles, paint marker, candidate count, nearest
candidate flat lengths, and the exact reason the STEP was withheld.

Regression command with customer files in a local (untracked) directory:

```sh
FLATFORGE_REGRESSION_DXF_DIR=/path/to/dxfs PYTHONPATH=backend python -m pytest backend/tests -q
```
