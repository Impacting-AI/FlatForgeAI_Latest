# Drawing angles before manual input

The September 29 change fixes two regressions: a hypothetical corner continuation
could clear a measured section angle, and the editable input appeared blank even
when the backend had a source angle. Known drawing rotations now populate the
input automatically. They are not saved as manual overrides unless edited.
“Use drawing” removes a saved override and rebuilds from source evidence.

## Evidence order

1. Extract the painted section/profile and map its wall chain to physical hinges.
2. Associate native two-line/three-point angular DIMENSION entities using their
   extension-ray intersection and both adjacent section wall directions.
3. Recognise exploded TEXT/MTEXT degree labels only when a unique same-layer ARC
   supplies those same rays. Unicode degrees, %%d and DXF Unicode escapes work.
4. If a dimension agrees with the geometric angle within 1°, use its stated
   magnitude in the mapped signed rotation. The section's paint orientation and
   hinge traversal supply the sign. Native dimensions without text overrides use
   their geometric measurement. Provenance includes dimension handle and vertex.
5. Without an applicable annotation, retain the measured section turn. With no
   unambiguous section-to-hinge mapping or direction, leave UNKNOWN for manual
   signed entry. Never assign 90° as a default.
6. A conflicting label or multiple inconsistent labels remain review evidence.
   Explicit overrides can build an unvalidated inspection model; the conflict
   remains in the report. Unrelated contour/relief angles are not fold angles.

An included 120° dimension normally describes a 60° rotation from flat. The
annotation's rays determine whether it measures the included or supplementary
angle; the number alone does not. Both the detected signed rotation and original
dimension are shown in Drawing Review.

A possible flange-continuation alternative no longer clears a section angle.
It remains a corner inspection flag, so known reference discrepancies do not
silently become validated manufacturing exports.

## Coverage and limitations

Native modelspace angular dimensions and geometrically linked exploded arc/text
annotations are supported. Bare nearby degree text, ambiguous arcs, dimensions
inside unexpanded blocks/layouts and screenshots alone do not establish a hinge
mapping. They must not silently supply a bend. Profile pairing, paint evidence,
strip tolerances and solid/unfold validation still apply.

The supplied PN_NM_144 screenshot shows a 120° profile angle and 60° contour
annotations. The original DWG/DXF was not supplied in this turn, so its exact
entity encoding and complete reconstruction have not been tested. No screenshot
number or panel filename is encoded in production logic.

## Local test deployment

No dependencies, material defaults or database schemas changed. To test the PR
branch in an existing git checkout (preserve any uncommitted local work first):

```sh
git fetch origin
git switch feature/drawing-linked-geometry-review
git pull --ff-only origin feature/drawing-linked-geometry-review
docker compose up -d --build frontend api worker
```

Reload the website and rebuild an existing drawing. Old artifacts do not update
until rebuild. Known angles appear as “Detected from drawing”; UNKNOWN angles
remain blank for signed input. Use “Save & rebuild panel” for normal processing.
For unresolved validation with known angles, the explicit review-model action
continues to provide an unvalidated inspection export.
