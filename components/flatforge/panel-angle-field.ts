/** Presentation only: never expands a displayed drawing angle into overrides. */
export function panelAngleField(summary:{values:number[];unresolved:number}|undefined, manual:unknown, edited:boolean, draft:string){
 if(edited)return {value:draft,type:'number' as const,readOnly:false};
 const values=summary?.values??[];
 if(values.length&&summary?.unresolved===0)return {
  value:values.length===1?String(values[0]):values.map(a=>`${a}°`).join(', '),
  type:values.length===1?'number' as const:'text' as const,readOnly:true,
 };
 return {value:typeof manual==='number'?String(manual):values.length===1?String(values[0]):'',type:'number' as const,readOnly:false};
}
