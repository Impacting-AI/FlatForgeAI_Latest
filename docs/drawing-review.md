# Tolerant drawing review

## Working requirement

Client clarification, 13 October 2026: the reference STEP models were created
manually and do not consistently use one radius, deduction or exact drawing
tolerance. Some DXFs omit values or contain inconsistent details. Use these
models as shape references, not as proof of a universal fabrication rule.
FlatForge must accept bounded drawing differences and expose missing values for
review. It must record corrections and the scope of validation.

Client clarification, 15 October 2026: use a 2 mm inside bend radius by default
without confirmation. Keep it editable for exceptions.

## Controls

Drawing Review and Material Defaults use the following parameters:

| Control | Default | Meaning |
| --- | --- | --- |
| Allowed length difference | 0.5 mm | Maximum strip residual for matching and final section-length checks; adjustable above 0 to 5 mm. |
| Allowed angle difference | 0.1° | Near-square drawing turns can normalize to 90°; local angle signatures and final angle checks use this tolerance. Range 0–2°. Numerical final checks have a 0.001° floor. |
| Angle to use when missing | 90° | Shared magnitude for the explicit positive/negative direction buttons. It never invents a missing direction automatically. |
| Bend calculation | Material model | Preserve the previous constant-K calibration at 90°, or explicitly choose fixed deduction at each angle for a shape model. |
| Individual bend values | Drawing / panel values | Current values are displayed. Edit a signed rotation, radius or deduction only when needed; **Use automatic** removes that bend’s corrections. |
| Inside bend radius | 2 mm | Applied automatically when absent from the DXF, without confirmation. Editable in Material Defaults or for an individual panel. |
| Use material defaults | Off | Set in Material Defaults for future uploads. Step 3 preserves the panel's saved policy without a checkbox. Permits configured fallback thickness/deduction where DXF evidence is absent; drawing values take priority. |
| Bend ends | Straight | Existing jobs retain constant-length ends. Select **Follow cut outline** for stepped ends, oblique end cuts and holes crossing a bend. |
| Corner-relief radius | Original DXF | Adjustment controls are temporarily hidden. Saved approved radii and their recorded locations/removed area remain active. |

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

## DXF-first values

Upload the DXF/DWG directly. No review JSON or client STEP is required.

- Repeated, uniquely paired section walls establish thickness in any rotation.
  A different workspace default does not override this measurement.
- Unambiguous normal right-angle section/flat-strip increments establish BD90
  independently of radius. All admissible measurements must agree within
  0.01 mm; sloped cut lanes and non-square profiles do not supply this inference.
- Marked section geometry supplies bend rotations when the matching chain and
  orientation are established. Valid 60°/120° bends retain their angles; only
  near-square noise within the selected tolerance can normalize to 90°.
- Scoped TEXT/MTEXT notes are also supported, in millimetres:
  `MATERIAL THICKNESS = 2 mm`, `ALL BENDS INSIDE RADIUS = 2 mm`, and
  `ALL BENDS DEDUCTION AT 90° = 4 mm`. These are supported note formats, not
  mandatory annotations. Arbitrary numbers, hole radii, and flat-outline angular
  dimensions never become global bend parameters. Conflicting or invalid
  supported notes require a correction and retain their original evidence.
- A sharp schematic section does not directly state inside bend radius. The
  client-approved default is 2 mm, applied without confirmation and still
  editable. Missing thickness/deduction values require input unless **Use
  material defaults** is enabled. Defaults cannot hide conflicting drawing evidence.

The fields show the effective values, with their source: drawing, configured material
rule, or recorded panel correction. A correction has priority over detection;
**Use automatic** removes that correction. The original drawing evidence remains
in the report. Changing one field does not convert the other displayed fields
into manual values. Workspace settings remain unchanged.

The API separates `configured_settings` from effective `settings` and reports
`parameter_resolution`. Review accepts `parameter_overrides` for thickness,
radius and deduction; `null` removes an override. Existing saved settings alone
are treated as fallback values, not evidence that the drawing contains them.
Previously confirmed/manual reviews remain accepted and are labelled as review
values. Missing radius uses the configured default automatically, including a
custom value saved in Material Defaults. Clearing a panel correction restores
the drawing value or configured default. Existing geometry validation still applies.

## Review workflow

1. Upload the drawing. Inspect automatically populated values and the numbered
   extraction. Only unresolved values or interpretations need input.
2. Enter or confirm a missing value, or correct an inaccurate value, then
   **Save & rebuild**. Keep the approved 0.5 mm / 0.1° limits unless a changed
   tolerance has been explicitly approved for the job.
   Saving is allowed while rotations remain unknown, so a parameter change can
   resolve matching before the user fills individual values.
3. Where local or normal section candidates fit, select the intended numbered
   bend chain. Selections are checked against current candidates on rebuild;
   a stale or conflicting selection returns to review.
4. Fill remaining signed rotations. Click a bend annotation or line in the flat
   viewer to edit its angle, radius or deduction. Source section / vertex
   references are read-only and remain associated with the exact hinge.
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

## Saved review support utilities

Step 3 no longer contains the saved-review upload interface. Existing project
reviews still load automatically, and the backend review-file endpoint and
rebuild script remain available for support/reproduction work. No client needs
to create a JSON alongside a drawing. Its file values mean measured thickness,
radius, deduction, signed rotations, and recorded review choices.

Import matches the SHA-256 of the extracted source DXF, never its filename or the
package's panel label. A renamed identical file works. A changed drawing, an
unmatched DWG conversion, duplicate matches, unknown bend keys, conflicting
rotations and invalid numbers are rejected. Missing rotations remain unknown;
old saved rotations are cleared when omitted from the imported schedule. Values
absent from the settings object keep the current panel setting and the preview
explains this. The file must contain the source note for manual bend/cut values.
Import is a preview: it saves nothing and queues no work until the user saves.
The save checks the panel revision, preventing a stale form from replacing newer
decisions. Review files are measured inputs, not automatic STEP interpretation.

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

The corner-radius adjustment UI is temporarily hidden; its backend rules and
existing saved values are preserved. Changes require a review note. Only identified junction circles
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
**Follow cut outline** when appropriate and enter bend values through the flat
viewer. Existing saved corner corrections remain active; their adjustment UI is
temporarily hidden. The support runner can still reproduce reviewed corner
corrections. Local geometry PASS does not establish exact
surface agreement with an external reference model. Use
`backend/scripts/inspect_step.py` to distinguish basic validity from detected
self-interference when examining a reference STEP.

To test private measured drawings through upload, review import, the worker and
STEP/project export (customer data stays outside the repository):

```sh
FLATFORGE_REVIEW_FILE=/private/review.json FLATFORGE_REVIEW_SOURCE_DIR=/private/drawings PYTHONPATH=backend python -m pytest backend/tests/test_reviewed_files.py -q
```

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
