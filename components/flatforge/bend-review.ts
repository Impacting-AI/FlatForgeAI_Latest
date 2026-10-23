import type { Bend, BendValues, Settings } from './types';
import type { ReviewValues } from './review-state';

export const bendFields = ['angle', 'radius', 'deduction'] as const;
export type BendField = typeof bendFields[number];
export type BendChange = (key: string, patch: BendValues | null) => void;

/** One update path for quick angles and the viewer editor.
 * null clears this bend's overrides using the existing review API convention.
 */
export function updateBendParameters(review: ReviewValues, key: string, patch: BendValues | null): ReviewValues {
  return { ...review, bend_parameters: {
    ...review.bend_parameters,
    [key]: patch === null ? {} : { ...review.bend_parameters[key], ...patch },
  } };
}

export function automaticBendAngle(bend: Bend) {
  return bend.confirmed ? bend.source.find(source => source.profile !== 'USER CONFIRMED')?.angle ?? null : bend.angle;
}

/** Preserve a deliberately empty field. In particular, '' must never mean zero. */
export function bendInputValue(bend: Bend, settings: Settings, review: ReviewValues, field: BendField): number | '' {
  const edit = review.bend_parameters[bend.key]?.[field];
  if (edit === null) return '';
  return edit ?? (field === 'angle' ? automaticBendAngle(bend) ?? '' : settings[field]);
}

export function bendValueError(values: BendValues, required = false): string | null {
  if (required && bendFields.some(field => values[field] == null)) return 'Enter signed rotation, inside radius and bend deduction. Empty fields are not zero.';
  if (values.angle != null && (!Number.isFinite(values.angle) || values.angle === 0 || Math.abs(values.angle) >= 180)) return 'Signed bend angles must be greater than −180°, less than 180°, and nonzero.';
  if (values.radius != null && (!Number.isFinite(values.radius) || values.radius <= 0 || values.radius > 100)) return 'Each bend radius must be above 0 and at most 100 mm.';
  if (values.deduction != null && (!Number.isFinite(values.deduction) || values.deduction < 0 || values.deduction > 100)) return 'Each bend deduction must be from 0 to 100 mm.';
  return null;
}

export type BendDraft = Partial<Record<BendField, { text: string; base: string }>>;

/** If another control changes this field, its current shared value wins over an
 * older un-applied draft. Edits to different fields remain staged independently.
 */
export function bendDraftText(draft: BendDraft, field: BendField, current: string) {
  return draft[field]?.base === current ? draft[field].text : current;
}

export function reviewError(value:ReviewValues,settings:Settings):string|null {
 const ranges:[number,number,number,string,boolean][]=[
  [settings.thickness,0,20,'Thickness',false],[settings.radius,0,100,'Radius',false],[settings.deduction,0,100,'Deduction',true],
  [settings.strip_tolerance??.5,0,5,'Length tolerance',false],[settings.angle_tolerance??.1,0,2,'Angle tolerance',true],[settings.default_angle??90,0,180,'Missing angle',false],
 ];
 for(const [n,min,max,name,zero] of ranges)if(!Number.isFinite(n)||(zero?n<min:n<=min)||n>max||(name==='Missing angle'&&n===180))return `${name}: enter a value ${zero?'from':'above'} ${min} and ${name==='Missing angle'?'below':'up to'} ${max}.`;
 for(const bend of Object.values(value.bend_parameters)){const error=bendValueError(bend);if(error)return error;}
 for(const radius of Object.values(value.relief_radii))if(radius!=null&&(!Number.isFinite(radius)||radius<=0))return 'Corner-relief radii must be positive numbers.';
 return (value.manual_bends||Object.values(value.relief_radii).some(r=>r!=null))&&!value.review_note.trim()?'Add a note stating where your confirmed bend or corner-cut values came from.':null;
}
