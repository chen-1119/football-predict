export interface OfficialScheduleEvent {
 eventId:string;businessDate:string;matchNum:string;homeTeamId:number;awayTeamId:number;homeTeamName:string;awayTeamName:string;
 saleState:'open'|'closed'|'awaiting'|'unknown';saleCutoffAt:string;
 kickoff:string;leagueName:string;matchStatus:string;sellStatus:string|null;quoteStatus:'matched'|'unavailable'|'conflict';
 markets:{poolCode:'HAD'|'HHAD';handicap:number|null;h:number;d:number;a:number}[];
}
export interface OfficialScheduleView {
 version:'signed-official-schedule-view-v1';businessDate:string;updatedAt:string;sourceReceivedAt:string;quoteReceivedAt:string;sourceCycleId:string;
 sourceSignatureVerified:true;recommendationEligibilityVerified:false;maximumAgeMs:900000;events:OfficialScheduleEvent[];
}
export function validateOfficialSchedule(value:unknown,expectedDay:string,now:number):OfficialScheduleView;
