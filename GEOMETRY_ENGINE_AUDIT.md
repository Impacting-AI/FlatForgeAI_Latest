# Reconstruction architecture and verification

This change repairs general parsing and evidence-handling defects. It does not claim universal support for complex drawings. Customer-specific identifiers, measurements and audit outcomes are retained privately.

## Geometry pipeline

1. Extract protocol-defined contour, bend axes and section walls separately from annotations.
2. Normalize within documented drafting/numerical tolerances, preserving provenance.
3. Construct physical faces and a connected fold tree from the contour and hinges.
4. Pair section walls in a shared local frame; orient midlines using paint evidence.
5. Measure signed turns and associate angular dimensions through geometry.
6. Generate section-to-hinge hypotheses and reconcile their shared-hinge constraints before assigning rotations.
7. Transport angles only through established source relationships.
8. Build parent-local transforms and planar/cylindrical BREP material using constant K from the bend-deduction calibration.
9. Validate actual sections, solid connectivity and unfolded material before manufacturing export.

## Changes

- `wall_pairing.py` replaces subtraction of unrelated global line offsets with perpendicular separation in a common local frame. Both ends of the wall overlap must fit the existing spacing tolerance. Wide-angle miter ends require adjoining paired-wall evidence. Pairing is mutually unique before entities are consumed.
- Thickness evidence uses the same geometry for oblique as well as orthogonal walls. Repeated dominant evidence remains required; defaults are not silently overwritten.
- `evidence_constraints.py` resolves candidate domains per connected shared-hinge component. Contradictory components remain unresolved. A bounded incomplete search cannot prove uniqueness. Numeric agreement checks cover the whole range of evidence, preventing order-dependent drift.
- Separated portions of one original KIFOF entity can inherit documented rotation with child-side frame transport. Collinearity or proximity alone is insufficient. Conflicting overlapping source groups cannot propagate trusted angles.
- Ill-conditioned topology recovery now exposes source-space coordinates, displacement, conditioning and nearby handles in the private engine report.
- `batch_audit.py` processes an external drawing folder into independent logs/artifacts and a private structured summary. Exceptions do not terminate the batch; stale output folders cannot contaminate a rerun.

No material defaults, tolerance limits, manufacturing gates or UI controls were relaxed. No new dependency or database migration is needed. The existing single panel angle field remains.

## Tolerance responsibilities

Arrangement precision, analytic recovery displacement, wall spacing, near-parallel eligibility, numerical hypothesis agreement, panel strip tolerance and final section-angle tolerance are separate quantities. A dimensional fit cannot justify an unresolved direction or topology. Only the existing tiny drafting-noise snap near 90 degrees is retained; arbitrary measured angles are not forced to 90 degrees.

## Remaining scope

Projected sections crossing nonparallel hinges need an observation-plane interpretation before apparent turns can become physical rotations. Partial/repeated details require explicit scope and coverage when their free-edge configuration differs from the full traversed chain. Ill-conditioned near-parallel boundary/cutter junctions need provenance-aware topology recovery. These limitations are not resolved by this change. Dimensional disagreements remain review conditions, not proof that a drawing is invalid.

The implemented normal-section and corroborated local-detail conventions remain explicitly identified. They are not universal rules for all possible fabrication drawings.

## Verification

- Full backend suite with externally supplied fixtures: 134 passed.
- Final focused constraint, wall-pairing, audit and station checks: 22 passed.
- Rigid-motion tests rotate, translate, rename and recreate entities in shuffled order. They compare topology, area, physical signed turns and interpretation status. Stable review outcomes are not counted as manufacturing successes.
- Unseen dimensions and non-90-degree rotations are checked through actual STEP/BREP generation, sections, unfolding and independent volume calculations.
- Existing successful solid regressions remain passing.
- No browser test or native DWG conversion was performed in this change.

## Local audit

With the existing backend environment activated, from the repository root:

```bash
python -m pip install -r backend/requirements-dev.txt
PYTHONPATH=backend python -m flatforge.batch_audit /path/to/dxfs /path/to/new-audit-output
```

The command exits nonzero when any file is not PASS. Keep its customer-specific `summary.json` and per-file artifacts private. Use a fresh output directory on each run.

```bash
PYTHONPATH=backend \
FLATFORGE_REGRESSION_DXF_DIR=/path/to/older-fixtures \
FLATFORGE_BATCH_DXF_DIR=/path/to/batch-fixtures \
OPENBLAS_NUM_THREADS=1 \
python -m pytest backend/tests -q
```

Fixtures remain external to the repository. Publishing this review branch does not merge or deploy it to a production server.
