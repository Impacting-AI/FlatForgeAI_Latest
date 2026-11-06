# STEP 6: persistent planar CAD mates

## Workflow

Add panels separately (the default), then **Connect / Mate → click reference
face → click moving face → preview → Apply Mate**. The Add picker can still
open the original side-connection workflow, and **Connect sides** retains
interactive L/R/T/B connections and occupied-side insertion.

Face picking highlights complete original BREP faces, with blue for the reference
and orange for the moving face. The picking proxies are tessellated per CAD
face; triangles are not treated as separate faces. Narrow flanges can be exposed
using the existing orbit/zoom controls. Boundary ambiguity and nonplanar faces
produce explicit messages. Clicking the reference/moving button reselects that
endpoint without discarding the numeric fields. Cancel discards the preview.

The contextual editor exposes gap, local U/V offsets, additional normal
separation, and in-plane rotation. It remains draggable through the existing
popup behavior. Save/export are disabled until previews are applied or canceled.

## Geometry and degrees of freedom

Face IDs are pinned to the immutable source STEP SHA-256. Rebuilt sources require
reselection; no nearest-face guessing is performed. Anchors are source-local
picked points validated against the original trimmed BREP, including holes,
within 0.001 mm picking tolerance.

For each planar face, V is source +Z projected into the plane, falling back to
source +Y when necessary; U = V × N. The reference panel's rigid transformation
carries this frame into the assembly. These directions are not screen axes.

The defined zero-offset default aligns picked points, opposes normals, and aligns
V axes. Twist rotates the moving frame about the reference normal. This is an
explicit fully parameterized planar relationship, not a general mechanical
constraint solver. Users control the otherwise ambiguous in-plane position and
rotation through U, V and twist.

For reference world anchor `a`, moving source anchor `b`, reference world frame
`(U,V,N)` and solved proper rotation `R`:

`t = a + U*offsetU + V*offsetV + N*(gap + normalOffset) - R*b`

U/V changes preserve normal separation. Normal adjustment explicitly changes the
total gap, which must remain nonnegative for an active mate. The preview reports
both measured plane separation and exact finite-face distance. If finite faces
no longer overlap in projection, it explains why those distances differ; this
does not invalidate a plane mate. No claim is made about the global shortest
clearance between entire panel solids. STEP 6 continues to allow intentional
solid overlaps without clash coloring or collision restrictions.

## Active mates versus Free Move

`AssemblyEntry.mateState` is optional and backward compatible:

- Absent: existing independent side/envelope positioning, unchanged.
- `active`: derive the pose from the selected faces and parent transformation.
  An independent `pose` is forbidden, preventing silent constraint overrides.
- `suspended`: preserve the mate parameters as provenance and use an explicit
  independent rigid pose. The interface never reports this as satisfied.

Edit mate updates active dependent panels in graph order. Unrelated frozen panels
stay fixed. Free Move first snapshots current placements, then suspends only
active edges crossing between moved and stationary panels. Thus moving B alone
in A → B → C freezes C and suspends A–B and B–C; descendants of C can retain
active internal relationships. Move branch is separate and preserves active
relationships inside the translated group. Edit mate / Apply Mate explicitly
resumes a suspended relationship.

Side insertion can translate a downstream active mate chain without freezing its
relationships. A side insertion that would reverse active mates or lacks named
connection-side references reports a conflict instead of silently rewriting them.

## Persistence and export

The existing `/assembly/place` engine is authoritative. It returns final rigid
matrices, source hashes, local frames, and active/suspended mate measurements.
`/assembly/validate` verifies the same matrices and signs them. The viewer applies
those matrices, converting translations from millimeters to meters exactly once.

Existing project Save Assembly stores mate state, face references, offsets,
twist, source revision and final transforms with revision compare-and-swap.
Saving does not recalculate placement. STEP export transforms the original CAD
solids with the same signed matrices; it neither remeshes nor fuses parts.
Face highlights, labels and controller arrows are excluded from exported geometry.

## Scope and limitations

Supported: opposing planar mates on unequal, irregular, folded or rotated panels;
local offsets/twist; active multi-panel trees; explicit suspension/resumption;
side-connection fallback; original-solid STEP export.

The first panel remains the fixed mate reference (Free Move can reposition it).
Each moving panel has one parent relationship; applying a replacement mate is
explicit in the editor. Cycles, missing references, duplicate identities and
independent poses conflicting with active mates are rejected. Closed loops,
multiple simultaneous constraints per component, curved/tangent/concentric mates,
and automatic topology repair after source rebuilding are not implemented.

## Verification

`backend/tests/test_active_mates.py` covers active chains, unequal/folded/rotated
geometry, local offsets, multiple gaps, source/cycle/pose conflicts, suspension,
save/reload, STEP re-import and downstream mates during side insertion.
`tests/active-mates.browser.mjs` exercises real WebGL face picking and the Python
CAD API, editing, validation, chain updates, Free Move, saving and STEP/GLB parity.
The existing side, insertion, movement and engineering suites remain regression
coverage. Run results are reported separately; listing a test is not a claim it ran.
