# Single panel bend-angle field

## Current interface (September 29 simplification)

Drawing Review contains one **Bend angle (° · included angle)** field.
The per-hinge inputs, signed approval buttons, angle-convention selector and
corner-candidate action buttons have been removed. Geometry and bend-source
details are collapsed, read-only inspections.

- A single detected drawing angle populates the field automatically.
- If the drawing contains different angles, the same field shows the detected
  values read-only (for example, `90°, 120°`). They are not flattened into a
  single angle, and the user does not need to enter values for each hinge.
- When an angle is missing, the user enters one panel-only included angle and
  uses **Save & rebuild panel**. A 120° included angle means 60° rotation from flat.
- Drawing-derived magnitudes take priority over the manual fallback. The engine
  keeps each fold's independently established direction. Complete eligible
  normal-section candidates may establish a common direction even while the
  angle magnitude remains unresolved. Ambiguous, truncated or partially covering
  candidate sets cannot establish that direction.
- If the drawing also lacks direction, or has conflicting evidence, one unsigned
  angle cannot solve it. The panel remains NEEDS_REVIEW with a drawing-evidence
  explanation; no guessed directions or hidden per-hinge controls are introduced.
- **Use drawing angles** clears the panel fallback and prior individual manual
  angle corrections on save. Entering a panel fallback also explicitly replaces
  old individual corrections. The backend retains the legacy API for compatibility,
  but the ordinary UI no longer sends individual angle edits.

Bend deduction stays a separate material parameter in **mm**, calibrated at 90°.
An angle in degrees and a deduction in millimetres cannot share one numeric value.
Workspace defaults and source files are unchanged.

## Drawing evidence

Native modelspace two-line/three-point angular DIMENSION entities are matched to
section walls by extension-ray geometry. Exploded degree TEXT/MTEXT is used only
with a uniquely associated same-layer arc and matching section walls. Unicode
and CAD degree encodings are supported. A compatible numeric dimension supplies
the magnitude; painted profile orientation and the mapped chain supply the sign.
Without an applicable numeric annotation, measured profile geometry is retained.
Unrelated flat-pattern cutting angles never automatically become fold rotations.
Bare text, unexpanded block/layout dimensions and ambiguous associations remain
limitations. The native PN_NM_144 file has not been supplied for panel-specific
verification; screenshots alone cannot establish every hinge association.

## API, persistence and validation

`POST /panels/{id}/review` accepts `panel_bend_angle_deg`, a finite included angle
strictly between 0 and 180, with `expected_revision`. Omission preserves the saved
value; explicit null clears it. A request cannot combine the single-field edit
with nonempty legacy `bend_angles`. Changes persist only on the panel and queue a
new revision. No database migration or dependency change is required.

`panel_bend_angle` in the result reports detected values, mixed/missing status,
manual fallback and unresolved count. Detected values are not silently converted
into manual overrides by displaying or saving unrelated settings. A user-supplied
magnitude does not waive section, thickness, unfolding or BREP checks.

Verification covers known-angle preservation, mixed-angle display, distinct
parent-local directions, consensus/ambiguity handling, invalid values, actual
STEP construction with a missing-magnitude fixture, API persistence/reset,
legacy correction clearing, revision checks and unchanged workspace defaults.

## Local test update

Preserve any local uncommitted work, then update the PR branch:

```sh
git fetch origin
git switch feature/drawing-linked-geometry-review
git pull --ff-only origin feature/drawing-linked-geometry-review
docker compose up -d --build frontend api worker
```

Reload and rebuild existing drawings. Previously generated artifacts do not
change until rebuilt. This branch has not been merged or deployed automatically.
