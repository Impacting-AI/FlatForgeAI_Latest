# Folded dimensions and drawing review

New rebuilds default to **Folded dimensions** validation. CONTOR remains the cutting blank. Thickness, radius, deduction and detected per-bend angles are unchanged.

## Operator steps

1. Open Drawing Review after extraction.
2. Keep detected angles and directions. Choose a missing direction only when the drawing or responsible designer establishes it. The panel included-angle field fills missing magnitudes; it does not replace different documented angles.
3. Open **Drawing geometry and angle sources**. Choose a source section and, if automatic correspondence is ambiguous, select its actual face chain. Highlighted faces identify the proposed chain. The screen shows its signed rotations and length discrepancy. Reset to Automatic to revoke the choice.
4. Check panel thickness, radius, deduction and strip tolerance. Changes affect this panel only. Do not increase tolerance merely to conceal a wrong interpretation.
5. Choose **Folded dimensions — report unfolding separately**, or the stricter **Folded dimensions and physical unfolding** mode.
6. Save and rebuild. Check folded CAD qualification and physical unfolding separately. Download diagnostics for outstanding problems.

A section selection is a correspondence decision, not permission to ignore failed dimensions. Candidate selection, direction and validation target are stored with the panel revision; stale submissions are rejected.

## Engine policy

Both modes require independent BREP, section, provenance, corner, overlay and overlap checks. A review export cannot become verified simply because a solid was generated.

Dimensional mode allows positive bend allowance with an implied K outside the sheet, but reports this as a physical warning. It also reports a failed inverse-unfold comparison without automatically rejecting otherwise verified folded CAD. Physical mode requires both compatible bend parameters and a passing inverse-unfold comparison.

Nonpositive allowance still blocks construction: the current finite-radius builder cannot consume a negative blank strip. Unknown direction, unresolved topology, unsupported section projection, contradictory drawing evidence and failed dimensions remain review/blocking conditions. This change does not solve those cases or guarantee equivalence to an approved STEP.

`verification.physical_unfolding` describes the implemented neutral-axis and inverse-geometry checks, not a forming simulation. Neither mode certifies manufacturing readiness. Private drawing evidence and reports must not be published to a public repository.

## Developer test steps

Run from the repository root:

```sh
PYTHONPATH=backend python -m pytest -o addopts='' backend/tests/test_dimensional_policy.py backend/tests/test_confirmed_rules.py backend/tests/test_solid_verification.py backend/tests/test_workflow.py -q
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Before installing on an existing server, back up its database, uploaded drawings, generated artifacts, configuration and current code revision. No database migration or new runtime dependency is required. Restart backend workers and rebuild/restart the frontend using the existing deployment procedure. Rebuild panels to apply the policy; existing exports and saved material defaults are not retroactively changed. Test on a non-production instance first.
