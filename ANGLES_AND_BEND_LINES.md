# Arbitrary-angle reconstruction and folded crease overlays

This change covers angle recovery, CAD construction, review and both viewers.
It extends the drawing-review change in the same pull request.

## Angle convention

The engine stores **signed rotation from flat**, about the parent-local hinge
axis. A section's polygon turn and painted-face handedness determine this value.
For the usual sheet corner, the included angle is `180 - abs(rotation)`.
Thus a 120.339° included corner needs a 59.661° rotation with the documented sign.
Entering 120.339° as a rotation would make a different corner.

All mapping paths share measured profile turns. Only drafting noise strictly
within 0.01° of 90° is snapped. The legacy HAT mapper now uses each bend's
`(r + t/2) * tan(abs(rotation)/2) - allowance/2` for strip matching, and no longer
rejects non-right-angle bends. The 90° bend deduction remains a material
calibration: `K = ((2*(r+t)-BD90)/(pi/2)-r)/t`. Other rotations use that same K.

Section-wall pairing also handles wide-angle miters. Endpoint separation beyond
one thickness is accepted only when adjoining wall segments meet the endpoints
and form a parallel pair at the material thickness. It is not a larger arbitrary
distance tolerance. Ambiguous pairs remain review conditions.

The BREP, GLB tessellation, unfolding and animation consume these signed angles.
No filename, special corner coordinate or constant 121° selects behavior.
Missing or conflicting evidence is never replaced with 90°.

## Review and unknown hinges

The existing signed-angle and section-correspondence editor remains available.
When a fold tree is extracted but section evidence is missing, its axes appear in
a labelled flat review preview. UNKNOWN axes are amber and identify themselves
as needing review on hover. The preview does not invent folded locations for
unknown descendants.

An operator can explicitly assign signed angles and request a review rebuild.
Missing section evidence and failed validation remain in the report; the review
STEP stays unvalidated and regular manufacturing STEP export remains blocked.
Existing successful marker-based chains and saved separated-tab overrides are
preserved. Material defaults are not changed.

## Bend-line graphics

`viewer.json` adds angle convention, included angles, per-hinge status and four
folded crease segments per known hinge: parent and child bend tangents on both
sheet surfaces. Their spans come from the same physical hinges used in CAD.
They use the final face transforms in millimetres, not a bounding-box estimate.

`BendOverlay.ts` supplies one shared transform and overlay implementation for
the 3D studio, animation and assembly. Blue dashed lines remain visible at
fraction 1 and show bend ID, signed rotation, included angle and source vertex
on hover. **Bend lines** defaults ON in both display panels. The software preview
also draws this overlay. Older viewer metadata derives it from hinge geometry.

The graphics are inspection overlays drawn over the surface, including hidden
creases. They are Three.js line objects, excluded from clash meshes and STEP
manufacturing solids. The exported GLB remains the solid tessellation; the web
viewer combines it with `viewer.json`. Assembly also stops applying a second
millimetre-to-metre scale to already metre-based GLB coordinates.

## Evidence and acceptance limits

Three images were supplied for this request: two fabrication drawings (one with
a 150° annotation, one labelled as without a defined panel bend angle), and one
CAD view with blue arrows at crease lines. They were inspected. The described
red-arrow failed-corner view and the measured 120.339° client view were not among
those attachments. No new DWG/DXF accompanied this request.

Consequently the exact photographed corner/notch cannot yet be certified against
the client reference. The tests establish arbitrary-angle recovery and correct
overlay placement on generated geometry; they do not claim that an unseen
drawing specifies the 59.661° rotation. Existing private DXFs are regression
inputs only and are not committed.

## Tests and update

```sh
PYTHONPATH=backend python -m pytest backend/tests -q
node --test tests/bend-overlay.test.mjs
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vite build --config vite.spa.config.ts
```

Set `FLATFORGE_REGRESSION_DXF_DIR` to include the private supplied drawings.
Backend tests import real STEP solids, check face normals and crease points
against their BREP surfaces, and exercise 30°, 60°, 59.661°, 90° and 120.339°
rotations. When Node/Three.js are installed, they also compare frontend animation
matrices and crease endpoints directly with the backend's exported transforms.
Node tests cover final visibility, dashed materials, return transforms, unknown
angles, toggle state and absence of solid overlay meshes.

There are no new runtime dependencies or database migrations. After merging,
update the checkout and rebuild the frontend, API and worker using the existing
deployment process. Rebuild affected drawings to refresh their solid and viewer
metadata. ODA conversion remains the existing configured DWG-to-DXF adapter.

## Subsequent corner-reference clarification

The later supplied failure/reference images and PN_NM_149(2).dxf establish a
corner-continuation conflict that the original angle-support change did not
resolve. See CORNER_ANGLE_REVIEW.md for the measured candidates, review gate and
remaining source-profile conflict. The earlier missing-image limitation above
describes the evidence available at that time.
