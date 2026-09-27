# Drawing-linked geometry review

FlatForge automatically reconstructs panels when the extracted contours, hinge
tree, painted section profiles and bend parameters establish a consistent model.
When correspondence is ambiguous, **Extract / Review → Geometry & fold rules**
now exposes the geometry-derived choices. It does not contain panel filenames,
fixed coordinates, or PN_NM_149-specific bend assignments.

## Using the editor

1. Upload a drawing, or rebuild an existing panel to generate the new report.
2. Open Extract / Review. Click a numbered hinge to identify its parent, child
   and positive rotation axis in the parent flat frame.
3. Choose a source section. The profile displays numbered vertices. Select a
   proposed face chain to highlight it on the flat pattern, including holes.
   Compare the measured flat strips, required flat strips and residuals.
4. Leave correspondence on **Automatic interpretation** when automatic evidence
   is sufficient. A selected chain uses that section's painted orientation and
   vertex turns; it does not invent an angle from how the panel looks.
5. If necessary, enter explicit signed rotations in degrees. Any finite nonzero
   angle strictly between −180° and +180° is supported by this review field.
   These are recorded as user decisions. **Reset** removes an angle override
   so the section evidence can determine it again.
6. Confirm missing material parameters in the existing parameter review area.
   Select **Save rules & build review model**. Every hinge must have an angle;
   contradictory section selections stop construction with an explanation.
7. Inspect the rebuilt model and validation report. If checks still fail, use
   **STEP · unvalidated review model** to inspect the reconstruction in CAD.
   This is not a manufacturing-approved export. Regular STEP export and project
   approved-results export remain blocked until the required checks pass.

Decisions affect this panel only. They survive a refresh and rebuild. Replacing
the source clears old decisions. Stale browser revisions and unknown candidate
IDs are rejected by the API rather than applied to different geometry.

## Implementation

- `section_mapping.py` preserves orientation with nearest-cut diagnostics.
- `detail_mapping.py` keeps the automatic 0.5 mm matching limit. Review proposal
  enumeration can expose candidates outside that limit without accepting them.
- `review.py` derives stable candidate IDs from chain topology and signed
  rotations. Candidates are ranked by residual, not automatically accepted.
  Normal-section choices require a cut normal to every crossed hinge; local
  edge-profile choices retain their different validation scope.
- `engine.py` applies selected section chains, then explicit angle overrides,
  then builds and validates the BREP. Failed or unexamined checks stay visible.
- `api.py` validates decisions and revision, persists panel overrides and queues
  the ordinary isolated conversion worker. No database migration is required.
- `GeometryReview.tsx` provides the geometry, chain, residual and angle editor.

## Scope and remaining limitations

This is a general review mechanism, not a guarantee that every CAD drawing is
automatically interpretable. It requires an extractable contour and fold tree.
It cannot repair missing contours, choose a new base/parent tree, infer missing
sections or paint evidence, or convert a folded-dimension sketch into a developed
blank. Those cases still need corrected source geometry or further parser work.

An explicit correspondence does not remove the approximately 1.922 mm strip
conflict currently reported for PN_NM_145. PN_NM_148 also retains its documented
dimensional/correspondence conflicts. PN_NM_135 has chains with no eligible
proposal. The editor exposes available evidence and allows explicit hinge
decisions for inspection; it does not certify those panels as accurate.

The PN_NM_149 automatic workflow is protected by the existing regression suite.
No customer source drawings are added to this repository. Actual DWG conversion
still depends on the configured ODA installation; this change does not replace
or install ODA.

## Updating an existing installation

After this change is merged, update your checkout from `main`. Preserve your
existing environment configuration and data volumes. For the supplied Compose
deployment, run:

```sh
git pull --ff-only origin main
docker compose up -d --build api worker frontend
```

For a manual installation, update the checkout, rebuild the frontend using your
existing deployment command, then restart both the Python API and worker. There
are no new dependencies or schema migrations. Rebuild affected existing panels
once to populate the review editor; their old reports do not contain its data.

## Verification

Run `PYTHONPATH=backend python -m pytest backend/tests -q`. To include the private
customer drawing regressions, set `FLATFORGE_REGRESSION_DXF_DIR` to their local
directory. Frontend checks use `tsc --noEmit` and
`vite build --config vite.spa.config.ts`.

Regression coverage includes arbitrary signed angles, invalid-angle rejection,
selected-chain persistence, stale revision and candidate rejection, real CAD
worker execution, review STEP import as a valid solid, failed-check preservation,
validated export blocking, override reset and unchanged global defaults.
