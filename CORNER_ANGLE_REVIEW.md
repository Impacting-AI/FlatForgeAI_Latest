# Corner-angle evidence and operator review

The September 28 corner reference supersedes the earlier visual approval of
the PN_NM_149 model. Previously, tests accepted the section-matched 90° result.
Those tests now require the newly identified corner conflict to stop conversion.

## Findings from the new attachments

The supplied PN_NM_149(2).dxf is byte-identical to the earlier file. It has no
angular DIMENSION entity. Its transverse profile maps to ±90° folds. Thus removing
a 90° software guard alone cannot change this case: that angle comes from the
matched profile, not a numerical fallback.

The reference shows a continuous flange around an oblique plate corner. For the
extracted hinge tree, aligning the adjoining flange normals gives:

| Hinge | Profile rotation | Continuation candidate | Adjacent face |
|---|---:|---:|---|
| C09 | +90° | +120.338659° | F5 |
| C02 | −90° | −59.661341° | F6 |

These signs refer to the displayed parent-local axes. A rotated drawing can
reverse a canonical axis and therefore reverse its signed rotation. The physical
result is invariant. The familiar 120.339° number is a rotation for C09 and an
included angle for C02; the screenshot number alone cannot specify a signed fold.

## General detection

`corner_review.py` finds adjoining flange axes meeting a plate hinge within the
existing 3 mm corner-relief distance. Using the extracted tree, it transforms the
parent normal, hinge axis and neighboring flange normal into one frame. If a
continuation is rotationally possible, its candidate is computed with:

`atan2(axis · (parent_normal × target_normal), parent_normal · target_normal)`

When that interpretation differs from the mapped angle by more than 1°, the
app reports `CORNER_ANGLE_CONFLICT`. It does not assume every such joint is meant
to be coplanar. It leaves the affected angle UNKNOWN and stops before folded
CAD generation until the operator enters an explicit signed angle. Re-selecting
a source section does not count as confirming this conflict.

The implementation contains no panel filename, fixed coordinates, bend IDs or
121° constant. Actual normal-section evidence still supplies arbitrary angles.
Missing evidence retains the existing UNKNOWN/manual-angle path.

## Operator workflow

1. Rebuild the drawing with the updated API and worker.
2. Open **Drawing Review → Geometry & fold rules**.
3. Inspect the highlighted hinge, interpreted profile angle, continuation
   candidate and neighboring face. Use **Use …° rotation**, or type the intended
   signed rotation in the override field.
4. Resolve every UNKNOWN hinge, then **Save rules & build review model**.
5. Inspect the model and validation report. Choices persist only for that panel.

For 149, explicitly using both candidates produces one valid connected BREP and
parallel adjoining flange normals. The unfolded-area check passes. However, the
original transverse section still fails: maximum turn difference is about
30.339°, and length difference is about 1.558 mm. The neighboring flange planes
also retain offsets of approximately 0.702 mm and 0.155 mm from the developed
pattern and bend allowances. This is a review model, not a certified seamless
manufacturing result. The source profile/blank or engineering intent needs to be
reconciled; raising strip tolerance cannot erase the angular conflict.

## Verification and rollout

Tests cover geometric candidates for several oblique angles, no extra conflict
at an orthogonal corner, missing angles, rotated/renamed/rehandled drawings,
explicit override reconstruction, section-selection bypass prevention and
retention of the failed drawing check. Existing 90° samples remain regressions.

This adds no runtime dependency or database migration. Merge the PR, rebuild
frontend/API/worker and rebuild affected drawings. Old exported artifacts are
not silently changed. The unvalidated STEP remains separately labelled; normal
manufacturing export still requires the required checks to pass.
