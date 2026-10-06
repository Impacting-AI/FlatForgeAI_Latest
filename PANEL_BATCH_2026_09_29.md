# September 29 panel batch: verified scope and remaining blockers

Evidence: both pages of `screencapture-localhost-5173-2026-09-29-18_52_10.pdf`.
The capture shows 14 DWG panels: 3 ready, 9 under review, 2 failed. The workspace
contains earlier DXFs for 135, 145, 148 and 149 only from this numbered batch.
Those DXFs reproduce the displayed failures/interpretations. The screenshot is
not a substitute for the other ten drawings or the exact DWG conversion output.

## Panel-by-panel findings

| Panel | Screenshot result | Verification / action |
|---|---|---|
| PN_NM_149 | Corner continuation inspection | Earlier DXF maps all section chains. A possible continuation differs from the documented transverse rotation; this remains a source/reference conflict. Known angles are retained. No automatic angle replacement or manufacturing approval. |
| PN_NM_148 | SECTION_01: 2.048 mm; SECTION_03: 0.850 mm; SECTION_02/04: non-normal chains | Reproduced with earlier DXF. SECTION_01 already measures 60-degree turns. Some strips do not fit the current t=2, r=2, BD90=4 constant-K model. Local side candidates also remain ambiguous; not fixed by a blanket 90/120 entry. |
| PN_NM_146 | Four unresolved hinge directions | Native file unavailable. Need the section-to-hinge and paint evidence; a common angle magnitude cannot establish four missing directions. |
| PN_NM_145 | SECTION_02: 1.922 mm | Reproduced with earlier DXF. Nonstandard profile rotation is 30.466250 degrees (149.533750 included), not an imposed 90. The developed strip and section/bend model do not agree within 0.5 mm. |
| PN_NM_144 | SECTION_01: 1.068 mm | Native file unavailable. Previous screenshots establish numeric annotations but not a unique complete hinge/profile mapping. |
| PN_NM_143 | SECTION_02: 0.672 mm | Native file unavailable. Requires segment residuals and source geometry before deciding whether parameters, section mapping or drawing dimensions are responsible. |
| PN_NM_142 | Zero-length bend/section line crash | Generic parser defect reproduced and patched with synthetic DXF/BREP tests. Exact panel still needs native-file verification. |
| PN_NM_141 | Zero-length bend/section line crash | Same parser repair; exact panel still needs native-file verification. |
| PN_NM_140 | SECTION_02: 0.672 mm; SECTION_03: ambiguous chain | Native file unavailable. A tolerance change cannot by itself resolve multiple competing face chains. |
| PN_NM_139 | SECTION_03 crosses nonparallel hinges | Native file unavailable. Requires projected/local profile interpretation, not treating apparent turns as normal-section rotations. |
| PN_NM_138 | Ready | No error shown. Native file unavailable; no additional validation claimed. |
| PN_NM_137 | Ready | No error shown. Native file unavailable; no additional validation claimed. |
| PN_NM_136 | Ready | No error shown. Native file unavailable; no additional validation claimed. |
| PN_NM_135 | SECTION_02/03/04 cross nonparallel hinges | Reproduced with earlier DXF. Transverse hinge supports differ by about 0.34 degrees from vertical and the end chain includes a 2.502-degree support change. They are not all exactly normal to one section cut. The current mapper cannot resolve the projected profiles unambiguously. |

## Concrete 148 evidence

For SECTION_01, the section already supplies 60-degree turns. With t=2 mm,
r=2 mm, BD90=4 mm and the calibrated constant K, the nearest normal chain gives:

| Segment | Flat drawing mm | Required by section + bend model mm | Difference mm |
|---|---:|---:|---:|
| 1 | 15.999845 | 17.023932 | -1.024088 |
| 2 | 34.000000 | 36.047865 | -2.047865 |
| 3 | 462.240000 | 463.418879 | -1.178879 |

The remaining three segments agree to roughly 0.001 mm. A bigger global strip
tolerance would conceal this evidence; it would not establish correct bend
parameters or correspondence. These results do not establish that the client's
drawing is wrong: its development convention may differ from the current model.

## Changes made

- Coincident KIFOF endpoints are ignored as nonphysical entities with source
  handles and an explicit normalization audit record. They do not create hinges.
- If all KIFOF entities are coincident, the drawing remains under review for missing usable bend geometry rather than crashing on an empty fold table.
- Coincident section entities are also audited. Finite short end caps retain the
  existing section treatment.
- Duplicate contour closing/consecutive vertices are omitted from direction
  recovery support lists only; material contour geometry is not removed.
- Generic line directions distinguish exact coincident points from finite short
  boundaries. Nonzero KIFOF axes below the 0.001 mm modelling resolution still
  require review, with the handle and length in the error. They are not silently
  discarded as CAD debris.
- Mapping reports retain the closest normal and projected candidates separately.
- Collapsed read-only Drawing Review diagnostics show measured profile turns,
  per-segment flat/required lengths, residuals and source handles. A small
  projected length residual is explicitly not treated as proof of a fold angle.

The single panel-angle field is retained. No tolerance, material default,
nonstandard rotation, fold direction or validation gate was relaxed to make a
panel appear ready. Projected-view solving and the source/reference discrepancy
are not claimed solved by this parser repair.

## Source identity (earlier DXFs, not the current DWG files)

| DXF | SHA-256 |
|---|---|
| 135 | d43ea11c18aebcf24a9d09c1c7a19e9ad84e89ca385a5281e529ba4e7cec8030 |
| 145 | 758d297c7d2df1a169e149d6b71106f808bd3c2ca61f3725fefa069105b92cfd |
| 148 | b126af4118af3877084337efbcd5e12d447906b5cde9a593b318f820f6e6fea6 |
| 149 | 29a7fcfcfa50b9cbba5c53b02b96be4473ea3d791e85ac4905b980930e50f3b5 |

## Required to finish the batch

Supply a ZIP with the exact 14 DWG/DXF files used for this run and, ideally, each
panel's report.json and ODA-converted flat.dxf. This is necessary to reproduce
146 and 139-144, verify the zero-entity repair on 141/142, and protect the ready
136-138 cases. A known-good folded reference for disputed projected profiles
would distinguish a missing development convention from inconsistent drawing data.
