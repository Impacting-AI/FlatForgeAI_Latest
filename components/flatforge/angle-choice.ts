/** Missing angles remain missing until an operator explicitly chooses a sign. */
export function fallbackRotation(value:number, convention:'included'|'rotation', direction:1|-1):number {
 if(!Number.isFinite(value)||value<=0||value>=180)throw new Error('Angle must be between 0 and 180 degrees.');
 if(direction!==1&&direction!==-1)throw new Error('Choose a fold direction.');
 return direction*(convention==='included'?180-value:value);
}
