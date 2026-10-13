# Tolerant drawing review

## Working requirement

Client clarification, 13 October 2026: the reference STEP models were created
manually and do not consistently use one radius, deduction or exact drawing
tolerance. Some DXFs omit values or contain inconsistent details. Use these
models as shape references, not as proof of a universal fabrication rule.
FlatForge must accept bounded drawing differences and expose missing values for
review. It must record corrections and the scope of validation.

## Controls

Drawing Review and Material Defaults now expose:

| Control | Default | Meaning |
| --- | --- | --- |
| Allowed length difference | 0.5 mm | Maximum strip residual for matching and final section-length checks; adjustable above 0 to 5 mm. |
| Allowed angle difference | 0.1° | Near-square drawing turns can normalize to 90°; local angle signatures and final angle checks use this tolerance. Range 0–2°. Numerical final checks have a 0.001° floor. |
| Angle to use when missing | 90° | Shared magnitude for the explicit positive/negative direction buttons. It never invents a missing direction automatically. |
| Bend calculation | Material model | Preserve the previous constant-K calibration at 90°, or explicitly choose fixed deduction at each angle for a shape model. |
| Individual bend values | Inherit | Optional signed rotation, radius and deduction for any reported hinge. Blank means drawing/panel values. |
| Bend ends | Straight | Existing jobs retain constant-length ends. Select **Follow cut outline** for stepped ends, oblique end cuts and holes crossing a bend. |
| Corner-relief radius | Original DXF | Enlarge a selected existing circular cut at a nonparallel bend junction. The original radius, new radius, location and removed area are recorded. |

Angles are rotations from flat. A 60° rotation leaves a 120° inside angle.
Positive rotations follow the reported canonical hinge axis using the right-hand
rule. A single magnitude cannot establish which side of the sheet a flange folds
towards.

The selected policy is used consistently in mapping, transforms, CAD bend
surfaces, painted GLB export, unfolding and motion preview. The fold CSV includes
each bend's effective radius, deduction, allowance and calculation policy.

Fixed deduction requires positive developed bend length. It can describe a
geometric shape whose implied neutral axis lies outside the constant-K material
model; the report records this as a warning. It does not establish tooling,
material behaviour or production bend compensation.

## Review workflow

1. Inspect the numbered extracted drawing and the reported differences.
2. Adjust the length/angle tolerance or panel values, then **Save & rebuild**.
   Saving is allowed while rotations remain unknown, so a parameter change can
   resolve matching before the user fills individual values.
3. Where local or normal section candidates fit, select the intended numbered
   bend chain. Selections are checked against current candidates on rebuild;
   a stale or conflicting selection returns to review.
4. Fill remaining signed rotations. Expand individual corrections only when a
   bend needs its own angle, radius or deduction.
5. If sections or finish markers are missing/unreliable, select **Use reviewed
   bend values instead of missing or unreliable section drawings**. Detected
   rotations are copied for review; missing ones still require input. Supply a
   note identifying the source of the values. The result explicitly records that
   section dimensions and paint orientation were not independently verified.
6. Inspect any proposed corner relief. Its removal requires a separate recorded
   choice before final export. Clearing that choice revokes the approval.

Manual values participate before automatic matching; conflicting drawing
evidence is not silently overwritten. To intentionally replace unreliable
sections, use the explicit manual mode. Corrections are stored per panel;
workspace defaults and other panels are unaffected. Replacing a source drawing
clears its old decisions through the existing source-replacement workflow.

## Geometry corrections

- Remove sub-grid duplicate contour vertices before rounding an otherwise valid
  oblique outline. Record entity handles and adjustment distances.
- Stop a bend-end extension at its first real outline crossing. Do not recover a
  distant infinite-line intersection from an almost-parallel extension tail.
- Identify small regions bounded only by bend-end extensions, with no original
  bend axis, as corner-relief proposals. Keep them in the original flat input and
  report their omission in unfolding; require explicit approval for final export.
- Pair section walls by unique parallel support, thickness and overlap. Do not
  assume their mitered endpoints differ by no more than one thickness; that
  assumption fails at non-90° folds. Profile connectivity and orientation still
  require evidence.

The topology grid, analytic mating checks, valid-solid requirement and unfolding
checks are not loosened by the drawing length tolerance.

## Section interpretation

Unmarked details are removed as redundant only when all their vertices match a
contiguous part of a marked section under rotation/translation within 0.002 mm.
Reflections and changed dimensions do not qualify. Original wall handles and
matching errors remain in `duplicate_section_details`; no painted direction is
invented for the copy.

Local details are searched against every possible base plate while preserving
the original fold-tree rotation convention. All distinct fitting chains remain
available for review. Candidates outside the selected tolerance are diagnostic
only and cannot be selected or silently committed.

## Shaped ends and local validation

In **Follow cut outline** mode the developed bend region is the material on both
sides of a hinge, clipped to its allowance band. Its boundary is mapped into
cylindrical surface coordinates. The solid retains true inner/outer cylinders,
stepped ends, holes and ruled cut faces. Rectangular bands use exact annular
extrusions. No panel names, source handles or measured customer values occur in
the construction rules.

The selected construction mode is explicit. Straight ends preserve the earlier
geometry convention; they still undergo the new checks. Some older examples
therefore return to review even in their original mode.

Validation now includes:

- One valid, connected exported STEP solid and an OpenCascade self-interference
  check. A closed-solid check alone does not detect every overlap.
- Actual BREP plane orientations against the prescribed rotations, using the
  selected angle tolerance, in addition to documented section checks.
- Both directions of local outline distance, including hole boundaries, with a
  bound between samples. The default engineering limit is **0.5 mm**. Sampling
  and seam normalization have a separate 0.02 mm allowance; they do not enlarge
  that engineering limit.
- Coplanar ownership across merged STEP faces, retaining unowned excess rather
  than clipping all measured geometry to the target outline.
- At folded contacts, fusion can remove internal painted skins while retaining
  material. A missing visible patch is restored to the coverage comparison only
  after a bounded grid checks its full thickness against the actual exported
  solid. An internal void fails this check. The 25,000-point limit leaves
  unproved patches unresolved rather than assuming success.

The report retains the raw visible-surface unfold, numerical seam changes,
contact proof, local-distance bounds, angular results and Boolean attempts.
Local coverage is not a claim of a certified 3D Hausdorff match to a client STEP.

Corner-radius changes require a review note. Only identified junction circles
can be enlarged, by at most 4 mm; arbitrary holes cannot be changed through this
control. Clearing a value restores the original. A changed `flat.dxf` contains
the approved radii, and `original_flat.dxf` preserves the source. STEP export is
still blocked if any other validation fails.

## Reference measurements

Keep measured customer bend schedules, source hashes, original files and
run reports outside the public repository. They are review inputs, never
universal rules or filename-based construction paths.

A private review JSON can contain a `panels` object, with each key holding
`source_sha256`, `settings` and `overrides`. Rebuild an exact reviewed drawing:

```sh
PYTHONPATH=backend python backend/scripts/rebuild_reference.py --review-file /private/review.json --panel panel-key --source /private/input.dxf --output /private/result
```

The runner refuses a changed source hash. In the application, select
**Follow cut outline**, enter the reviewed bend values and record any corner
corrections before rebuilding. Local geometry PASS does not establish exact
surface agreement with an external reference model. Use
`backend/scripts/inspect_step.py` to distinguish basic validity from detected
self-interference when examining a reference STEP.

## Compatibility and limits

The old bundled examples 1570, 1619 and 1648 still produce valid solids with their
original straight-end construction and unchanged overall dimensions. Their
section and area checks pass, but local discrepancies of 2–2.828 mm fail the new
0.5 mm gate. Tests now require `NEEDS_REVIEW` for these files instead of retaining
an unsupported PASS. The API success/STEP round-trip test uses a dimensionally
consistent synthetic channel, and these real examples remain separate negative
regressions. They need further end/relief review before new final exports.

The work does not infer radii absent from other drawings, replace missing axes,
implement arbitrary curved hinge axes, or establish universal fabrication
compensation. The client STEP uploads are measured offline here; the application
does not yet automatically import and interpret arbitrary reference STEP files.
