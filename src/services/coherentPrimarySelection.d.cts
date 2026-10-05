type Code='1'|'X'|'2';
type Vector=Record<Code,number>;
export interface CoherentPrimary {version:'coherent-market-primary-v1';anchorMarket:'HAD'|'HHAD';anchorCode:Code;anchorProbability:number;hadCode:Code;hhadCode:Code|null;jointProbability:number|null;companionConditionalProbability:number|null;jointProbabilities:Record<Code,Vector>|null}
export const VERSION:'coherent-market-primary-v1';
export function selectCoherentPrimary(p:Vector,hp:Vector|null|undefined,joint:Record<Code,Vector>|null,line:number|null|undefined,available:boolean):CoherentPrimary|null;
export function validCoherentPrimary(value:unknown,p:Vector,hp:Vector|null|undefined,line:number|null|undefined,available:boolean):boolean;
