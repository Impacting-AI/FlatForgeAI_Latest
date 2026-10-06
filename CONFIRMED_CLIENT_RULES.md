# Confirmed client rules

The engine treats CONTOR as the developed cutting blank, including holes and reliefs. It does not deduct material from the outline again. The input-type setting remains editable; folded-dimension input still requires a developed-pattern export.

New workspace defaults are thickness 2 mm, inside radius 0.7366 mm and total bend deduction 4 mm. Deduction is fixed per bend at every angle, not a 90-degree calibration. Existing saved workspace/panel parameters are preserved. In Settings, choose **Use confirmed client values**, then Save. Repeat in Drawing Review for existing panels that should use the new parameters; their saved snapshots are not silently overwritten.

For signed fold rotation θ, the implementation uses:

- Included angle = 180 − |θ|.
- Outside setback per side = (r + t) tan(|θ|/2).
- Bend allowance = 2 (r + t) tan(|θ|/2) − BD.
- Per-bend K = (allowance / |θ in radians| − r) / t.

All section matching, solid construction, unfold mapping and animated bend geometry use this same allowance. Viewer hinges carry their own K-factor; the old common K-factor cannot represent fixed deduction at different angles.

## Parameter conflicts

The confirmed constants cannot create a physical constant-thickness bend at every angle. For example, r=0.7366, t=2, BD=4 and an included angle of 120° (rotation 60°) produce a negative allowance. No positive-width strip can become that bend. The engine reports BEND_PARAMETERS / NEEDS_REVIEW with the angle, allowance and K, and does not emit a solid. It never clamps allowance, changes radius or substitutes a 90° rotation to hide the conflict. A valid allowance must be positive and the implied neutral axis must lie within the sheet (0 ≤ K ≤ 1).

The client’s three supplied reference STEP files only demonstrate 90° bends. They do not independently establish a physically consistent fixed-deduction rule for other angles. A non-90° reference or clarification of how those drawings are developed is still needed for conflicting cases.

## Drawing Review

- Angular labels matched to HAT wall geometry are included angles. A disagreement with the profile turn remains an explicit conflict.
- Drawing angles take precedence. When magnitude is missing, the panel angle field shows an editable 90° fallback. Saving confirms that displayed fallback only for missing magnitudes.
- Every reported hinge shows its direction and an Up/Down selector. Up means the child moves toward parent-local +Z; Down means toward −Z. Source angles remain linked to drawing evidence.
- Missing direction is never guessed. Select it before building. Choosing Drawing again removes the manual direction on the next rebuild.
- Overrides are panel-specific, revision-checked and saved in diagnostics.

## Demonstration

1. Update API, worker and frontend from the same commit; restart API and worker and rebuild frontend. No added dependencies or database migration are required.
2. Save the confirmed client values in workspace Settings; existing panel settings are edited separately.
3. Upload a 90° drawing and inspect radius, dimensions, section checks, unfold result and STEP validity.
4. Upload a drawing-defined non-90° bend with physically compatible parameters; verify included angle, per-bend allowance and folded crease overlay.
5. Test the conflicting 120° included-angle example at the confirmed defaults. Expect NEEDS_REVIEW with numerical parameter diagnostics, not a guessed solid.
6. For an unresolved direction, select Up/Down, save, inspect the result and verify that selecting Drawing removes the override.
7. Keep the source DXF/DWG, expected STEP when available, diagnostics ZIP and screenshots for each discrepancy.

These changes do not resolve every projected-section correspondence or topology problem. They also do not make folded-dimension drawings into cutting blanks automatically.

## Verification of this change

- Backend regression suite: 112 passed, 44 optional fixture tests skipped; an additional API direction-persistence/revocation test was added afterward.
- Viewer/angle-field tests: 11 passed. TypeScript no-emit check passed.
- Separate private reference runs at the confirmed defaults: 1648 PASS (990 × 2917 × 55.0000001 mm); 1570 valid single solid (2034 × 670 × 358.0000001 mm), with C-C partial-section confirmation still required; 1619 NEEDS_REVIEW because two hinge directions remain unresolved. These are current engine outcomes, not a claim of complete STEP-to-STEP equivalence.
