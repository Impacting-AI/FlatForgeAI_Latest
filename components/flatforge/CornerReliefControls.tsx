'use client';
import type { Panel } from './types';
import type { ReviewValues } from './review-state';

/** Retained for restoration; Step 3 does not render these controls. */
export default function CornerReliefControls({panel,value,onChange}:{panel:Panel;value:ReviewValues;onChange:(v:ReviewValues)=>void}) {
 return <>{!!panel.report.relief_circles?.length&&<details className="bend-overrides"><summary>Adjust corner-relief cuts</summary>
   <p>Enter the radius required by the approved shape. Blank restores the original DXF cut. These changes are recorded and included in the exported flat drawing.</p>
   <div className="table-wrap"><table className="calculation-table"><thead><tr><th>Corner / drawing position</th><th>Original radius mm</th><th>Approved radius mm</th></tr></thead><tbody>{panel.report.relief_circles.map(c=><tr key={c.handle}><td>{c.handle}<small>X {c.center_dxf_mm[0].toFixed(2)}, Y {c.center_dxf_mm[1].toFixed(2)}</small></td><td>{c.original_radius_mm}</td><td><input type="number" step="any" min={c.original_radius_mm} max={c.max_radius_mm} aria-label={'Corner radius '+c.handle} placeholder={c.original_radius_mm.toString()} value={value.relief_radii[c.handle]??''} onChange={e=>onChange({...value,relief_radii:{...value.relief_radii,[c.handle]:e.target.value===''?null:Number(e.target.value)}})}/></td></tr>)}</tbody></table></div>
   {Object.values(value.relief_radii).some(radius=>radius!=null)&&<><label htmlFor="corner-review-note">Source of approved corner-cut values</label><textarea id="corner-review-note" maxLength={2000} value={value.review_note} onChange={event=>onChange({...value,review_note:event.target.value})}/></>}
  </details>}</>;
}
