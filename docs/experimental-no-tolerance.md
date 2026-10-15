# Experimental builds without tolerance rejection

Branch: `experiment/no-tolerance-gates`, based on `9ea1db8` of
`fix/tolerant-drawing-review`. Main and the normal review branch are unchanged.

This branch disables drawing tolerance rejection by default. Restart the API
and CAD worker from this branch and run the frontend from the same checkout.
Upload a drawing, or use **Save & rebuild panel** for an existing panel. Stored
results are not automatically rebuilt or relabelled.

Section matching retains the existing within-limit matches. When none exist,
it considers the closest geometrically supported normal/local candidates
without a maximum dimensional error. Tied assignments, contradictory rotations,
and uncorroborated local details still require the existing review decision.
Out-of-limit local candidates remain selectable through drawing review.

After construction, dimensional, angular and unfolded-outline/area differences
are measured against the original settings and retained in the reports. Those
differences alone do not block STEP or project ZIP export. The workspace banner,
report `tolerance_policy` and fold CSV identify experimental results. API status
`PASS` means export is available in this mode, not that tolerance checks passed.
Individual check results can correctly remain `FAIL`.

Missing values and bend axes, ambiguous directions, invalid material parameters,
invalid/disconnected or self-intersecting solids, missing section material,
unobserved plates and explicit relief approvals retain their existing handling.
The 2 mm editable radius default and near-square angle normalization are unchanged.
Tolerance fields remain reference measurements and evidence-consistency settings;
disabling rejection does not replace missing or contradictory drawing data.

To restore the original behaviour, switch back to `fix/tolerant-drawing-review`,
restart the services and rebuild the experimental panels. There is no database
migration or persistent setting that disables tolerance enforcement in that branch.

Verification: 39 backend tests passed, 18 optional fixture cases skipped; the
six experimental-export and section-station checks also passed on the final
mapping changes. TypeScript passed. The main frontend component retains its
existing seven lint errors and eleven warnings; the experiment adds none.
The API/worker test exports a valid PL1648 STEP and project ZIP while preserving
the approximately 2 mm local-outline failure in the report. Fresh NM147/NM148
DXF-only runs still require unresolved bend values/section decisions and a
deduction value; this experiment does not fill those from a reference STEP.
