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

## Supplied panel results and remaining work

NM147 now partitions into 19 faces and 18 physical hinges, without the original
zero-length or distant-junction errors. The section parser then cannot associate
walls `E6/E7` with a nearby painted-side marker. Automatic orientation remains
unresolved. Correct/identify the section marker in CAD, or supply a reviewed bend
schedule through manual mode. Its small corner proposal contains approximately
0.2933 mm² of original material and needs review.

NM148 maps sections 2 and 4 using the default 0.1° angular tolerance. With the
explicit fixed-deduction setting, sections 1, 2 and 4 fit within 0.5 mm; section 3
offers a local candidate with approximately 0.368 mm error. Confirming that
candidate resolves all four profile mappings, but rotations for `C03`, `C04`,
`C05` and `C09` still require evidence or user input. These IDs are diagnostic
labels from this source, not rules embedded in the engine.

Neither supplied panel is claimed to have a completed, verified folded solid in
this change. Their missing decisions are now accessible in review. Numeric
fields cannot supply absent contour geometry, missing bend-axis positions,
unsupported curved folds or a disconnected large region. Those require a CAD
correction or a future geometry-editing feature.

## Validation and reproduction

The available automated suite passes with the two supplied files enabled:

```bash
PYTHONPATH=backend FLATFORGE_PAIR_DXF_DIR=/path/to/uploads python -m pytest -q backend/tests
```

The pair directory uses the uploaded filenames `PN_NM_147(1).dxf` and
`PN_NM_148 (1)(1).dxf`. Customer files remain outside the repository. Other
optional customer fixtures use `FLATFORGE_REGRESSION_DXF_DIR` as before.

Coverage includes rotated duplicate contours, an actual 0.65 mm discrepancy
that fails at 0.5 mm and passes at 0.8 mm, near-square drawing noise, real 60°/120°
STEP solids, different radii on one solid, missing sections, API persistence and
clearing of decisions, and prior bundled reference panels. Production build,
TypeScript and lint checks on the new controls also pass. Interactive visual QA
still needs to be run: the available browser could not reach the local server.
