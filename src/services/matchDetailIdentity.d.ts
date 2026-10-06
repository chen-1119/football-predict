export const DETAIL_IDENTITY_VERSION: string;
export interface DetailIdentityBinding {
  version:string; requestedId:string; canonicalId:string; sourceMatchId:string; eventVersion:string; kickoffTime:string;
  homeTeamId:string; awayTeamId:string; matchNo:string; businessDate:string; saleCutoffTime:string; saleCutoffEpochNanoseconds:string;
  deadlineBasis:string; decisionId:string; decisionRecordHash:string; decisionPublishedAt:string; decisionCutoffTime:string;
  sourceObservedAt:string; sourceReceivedAt:string; generationId:string; manifestHash:string; sourceCycleId:string; committedAt:string; observedAt:string; contentHash:string;
}
export function exactDetailClock(value:unknown):bigint|null;
export function detailAliasSource(id:unknown):string|null;
export function detailEventIdentity(match:unknown,allowOfficialLocal?:boolean):Partial<DetailIdentityBinding>|null;
export function sameDetailEvent(a:unknown,b:unknown):boolean;
export function detailBindingBody(binding:unknown):Record<string,unknown>|null;
export function validateDetailBindingFields(requestedId:string,match:unknown,binding:unknown,options?:{now?:number;expectedGenerationId?:string|null}):boolean;
export function acceptMatchDetail(requestedId:string,match:unknown,options?:{now?:number;expectedGenerationId?:string|null;subtle?:SubtleCrypto}):Promise<boolean>;
export function detailResponseMatchesFields(requestedId:string,match:unknown,now?:number):boolean;
