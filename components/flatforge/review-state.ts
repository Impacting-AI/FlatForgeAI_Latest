import type { BendValues, Panel, ParameterValues } from './types';

export type ReviewValues={parameter_overrides:ParameterValues;relief_radii:Record<string,number|null>;bend_parameters:Record<string,BendValues>;section_choices:Record<string,string|null>;manual_bends:boolean;review_note:string;accept_corner_reliefs:boolean};
export const emptyReview:ReviewValues={parameter_overrides:{},relief_radii:{},bend_parameters:{},section_choices:{},manual_bends:false,review_note:'',accept_corner_reliefs:false};
export function savedReview(panel:Panel):ReviewValues {
 const saved=panel.overrides;
 const bends={...saved.bend_parameters as Record<string,BendValues>|undefined};
 for(const [key,angle] of Object.entries(saved.bend_angles as Record<string,number>|undefined??{}))bends[key]={angle,...bends[key]};
 return {parameter_overrides:{...saved.parameter_overrides as ParameterValues|undefined},relief_radii:{...saved.relief_radii as Record<string,number>|undefined},bend_parameters:bends,section_choices:{...saved.section_choices as Record<string,string>|undefined},manual_bends:saved.manual_bends===true,review_note:typeof saved.review_note==='string'?saved.review_note:'',accept_corner_reliefs:saved.accept_corner_reliefs===true};
}
