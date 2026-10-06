# FlatForge: installation, demonstration and issue collection

## Install this update

Use the reviewed `feature/panel-review-normalization` branch. This includes the
earlier drawing-angle, bend-overlay and evidence-reconciliation changes that
were not merged into main. Back up the database and uploaded drawings first.

```bash
git fetch origin
git switch feature/panel-review-normalization
git pull --ff-only
python -m pip install -r backend/requirements.txt
```

Rebuild the frontend using your existing deployment build command and restart
both the API and CAD worker. No new database migration or additional dependency
is introduced by this update. Do not overwrite local environment configuration.
Existing results are unchanged until each panel is rebuilt.

## Requirements

- Python CAD worker with the pinned backend dependencies and writable storage.
- Frontend/API connection and a running worker; confirm these in the app.
- For DWG: ODA File Converter installed **on the worker**, with
  `ODA_FILE_CONVERTER` pointing to its executable. Set `ODA_XVFB=1` only when your
  Linux installation requires a virtual display. DXF does not require ODA.
- One developed sheet blank per drawing, in millimetres under the drawing's
  established unit convention; CONTOR, KIFOF and HAT (or the supported section
  alias), plus painted-face evidence.
- Confirmed thickness, inside radius and 90-degree bend deduction. A reference
  model may use a different radius from existing workspace defaults. Do not
  change radius merely to suppress a dimensional error.

## What this update adds

- Closed, nonbranching CONTOR LINE rings and classic 2D POLYLINE outlines can be
  converted to the contour representation used by the engine. Holes are kept.
- Straight KIFOF polyline segments become individual physical-axis candidates.
  Curved axes and nonplanar hinge polylines require review, not straightening.
- Normal sections can match an individual connected material region when the
  same cut crosses additional regions separated by physical gaps. A connected
  chain is never truncated simply to force a segment-count match.
- Drawing Review exposes **Build review model** and **Download review STEP ·
  unvalidated**. Review generation preserves issues and requires known signed
  hinge rotations and a valid solid. It does not unlock manufacturing exports.
- Existing parameter, partial-section and relief-extension confirmations can
  now be switched off again. Their saved state is shown when reopening review.
- **Download diagnostics** supplies the revision, settings, decisions, source
  hash, engine fingerprint, report, current-revision job logs and available
  section/extraction tables. It excludes source CAD and application credentials.
  Geometry and logs remain customer data; share the ZIP privately.

## Demonstration steps

1. Record the installed Git commit (`git rev-parse HEAD`). Check worker and ODA
   availability. Test a native DXF first, then its equivalent DWG if available.
2. Create a test project. Set the confirmed material parameters. Upload one
   reference drawing and record its revision before adjusting anything.
3. In Drawing Review, check the contour, holes, numbered hinges, section mapping
   and detected angles. No degree label is needed if section geometry establishes
   the angle. Included angles and signed rotations are different quantities.
4. Reconstruct with default tolerances. Open the folded model, turn bend lines
   on/off, inspect angle/source information and test the fold animation.
5. Compare against the matching client STEP in CAD after rigid alignment. Check
   thickness, bend radii, flange lengths, local corner geometry, hole locations,
   bend directions and angles. Matching a bounding box alone is insufficient.
6. Download STEP, fold table and validation report. A PASS means the implemented
   checks passed with the recorded settings, not proof of reference equivalence.
7. Repeat with non-90-degree examples, rotated drawings and equivalent entity
   representations. Preserve both passing and failing cases.

## Continuing past a small discrepancy

There is deliberately no universal "ignore geometry errors" switch.

| Situation | Action | Effect |
|---|---|---|
| Accepted strip-length discrepancy | Set this panel's strip tolerance in mm; save and rebuild | Applies to matching and length checks only; the value is reported. A larger tolerance may also create mapping ambiguity. |
| Documented chain passes, but the plane includes additional regions | Inspect the section and explicitly confirm it is a partial detail | Accepts section scope; does not excuse a failed documented chain. |
| Engine offers a bounded relief extension | Inspect the proposed gaps and confirm the listed extension | Accepts only that existing bounded proposal. |
| Want to inspect an available reconstruction with checks outstanding | Build review model | Keeps NEEDS_REVIEW and exposes an unvalidated review STEP if a valid solid can be built. |
| Missing angle magnitude with established direction | Use the panel included-angle field | Fills missing magnitudes only; known drawing angles are kept. |
| Unknown direction, conflicting evidence, non-tree topology, invalid solid | Correct/review the evidence and collect diagnostics | No valid automatic bypass. |

To revoke a confirmation, uncheck it and rebuild. To restore the standard strip
tolerance, use Reset to 0.5 mm. Other panels and workspace defaults are unchanged.

## Send this evidence when a panel fails

- Original DWG/DXF and exact filename/revision; exported DXF if DWG conversion
  itself is in question.
- Downloaded diagnostics ZIP **after the job completes**.
- Expected STEP, if available, and a screenshot marking the exact discrepancy.
- Expected and observed dimension/angle; indicate included angle versus rotation.
- Installed Git commit, operating system, ODA version and reproduction steps.
- Whether this is a fresh upload or rebuild, and every manual tolerance/parameter
  adjustment. The diagnostics records the current saved decisions.

## Developer verification

```bash
python -m pip install -r backend/requirements-dev.txt
PYTHONPATH=backend python -m pytest backend/tests -q
node node_modules/typescript/bin/tsc --noEmit
PYTHONPATH=backend python -m flatforge.batch_audit /path/to/input /path/to/fresh-output
```

Use `FLATFORGE_REGRESSION_DXF_DIR` and `FLATFORGE_BATCH_DXF_DIR` to enable the
external customer-fixture tests. Keep drawings and detailed batch reports out of
public source control. The batch command intentionally exits nonzero if any
panel remains unvalidated. Never reuse a populated output directory.

## Remaining limits

Projected views crossing nonparallel hinges, arbitrary partial details and
ill-conditioned corner topology are not universally solved. General nested-block
and layout normalization, curved fold axes, formed ribs and folded-dimension
inputs remain outside this change. Reference agreement must be measured;
increasing tolerance or successfully exporting a STEP does not establish it.
