import { buildApiUrl } from './runtimeUrls';

export interface AccountUser { id:string; username:string; displayName:string; role:'user'|'operator'|'admin'; status:'active'|'blocked' }
export interface AccountAccess { active:boolean; kind:'trial'|'legacy-code'|'manual'|null; expiresAt:string|null; trialAvailable:boolean }
export interface AccountSession { ok:boolean; user:AccountUser|null; access:AccountAccess; authMethods:{password:boolean;sms:boolean}; csrfToken:string; sessionExpiresAt?:string|null }
export interface FollowDecision { decisionId:string; recordHash?:string; tipCode:string; odds:number|null; publishedAt:string; market?:string; handicapLine?:number }
export interface FollowResult { state?:string; score?:string|null; status?:string; source?:string|null; asOf?:string|null; updatedAt?:string; checkedAt?:string }
export interface FollowRow { id:string; matchId:string; sourceMatchId?:string; eventVersion?:string; homeTeamName:string; awayTeamName:string; kickoffTime:string; createdAt:string; decision:FollowDecision|null; result:FollowResult|null }
export interface PendingFollow { matchId:string; decisionId?:string; returnTo:string; createdAt:number; intentId:string }
export const emptyAccountAccess:AccountAccess={active:false,kind:null,expiresAt:null,trialAvailable:false};

export class AccountApiError extends Error {
  status:number;
  code:string;
  constructor(message:string,status:number,code=''){super(message);this.name='AccountApiError';this.status=status;this.code=code;}
}
const accountErrors:Record<string,string>={invalid_username:'账号名需为 3–32 位字母、数字或 _ . -。',invalid_password_length:'密码需为 15–128 个字符。',invalid_display_name:'显示名称不能超过 40 个字符。',invalid_credentials:'账号或密码不正确。',invalid_recovery_credentials:'账号或恢复码不正确，请检查后重试。',authentication_required:'登录已失效，请重新登录。',authentication_busy:'登录服务繁忙，请稍后重试。',authentication_rate_limited:'操作过于频繁，请稍后重试。',username_taken:'此账号名已被使用，请更换。',trial_already_claimed:'此账号已经领取过体验。',invalid_access_code:'访问码无效或已过期。',access_code_unavailable:'此访问码已被使用或无法兑换。',fixture_identity_unavailable:'比赛资料尚未就绪，请稍后再关注。',decision_not_found:'这条历史分析暂时无法读取，请从比赛页面重新关注。',decision_match_mismatch:'记录与比赛不一致，请返回比赛页面重试。',csrf_rejected:'会话验证已更新，请刷新页面后重试。',origin_rejected:'无法验证当前站点，请从网站首页重新进入。',insufficient_role:'当前账号没有此操作权限。',password_authentication_disabled:'账号登录暂未开放。',legacy_redemption_unavailable:'访问码兑换暂不可用，请稍后重试。',session_not_found:'该设备已经退出登录。',follow_limit_reached:'最多关注 200 场比赛，请先取消部分关注后再添加。'};
export async function accountRequest<T>(path:string,options:{method?:string;body?:unknown;csrfToken?:string;signal?:AbortSignal}={}):Promise<T>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)controller.abort();
  try{
    const response=await fetch(buildApiUrl(`/api/account${path}`),{method:options.method||'GET',credentials:'include',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',...(options.body!==undefined?{'Content-Type':'application/json'}:{}),...(options.csrfToken?{'x-csrf-token':options.csrfToken}:{})},...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})});
    let payload:Record<string,unknown>;
    try{payload=await response.json();}catch{throw new AccountApiError('账号服务暂时无法响应，请稍后重试。',response.status);}
    if(!response.ok||payload.ok===false){
      const detail=payload.error&&typeof payload.error==='object'?payload.error as Record<string,unknown>:{};
      const code=String(payload.code||detail.code||(typeof payload.error==='string'?payload.error:''));
      const message=accountErrors[code]||(typeof payload.message==='string'?payload.message:typeof detail.message==='string'?detail.message:'操作未完成，请稍后重试。');
      throw new AccountApiError(message,response.status,code);
    }
    return payload as T;
  }catch(error){
    if(error instanceof AccountApiError)throw error;
    throw new AccountApiError(controller.signal.aborted?'连接超时，请重试。':'网络连接中断，请检查连接后重试。',0);
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}

// Return paths are local routes only. Do not persist passwords, cookies or CSRF tokens.
export function safeAccountReturnTo(value:unknown,fallback='/best'):string{
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u001f]/.test(value))return fallback;
  try{
    const decoded=decodeURIComponent(value);
    if(decoded.startsWith('//')||/[\\\u0000-\u001f]/.test(decoded))return fallback;
    const url=new URL(value,'https://football.invalid');
    if(url.origin!=='https://football.invalid'||/^\/auth(?:\/|$)/.test(url.pathname))return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  }catch{return fallback;}
}
const PENDING_KEY='football.account.pending-follow.v1';
const validIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f]/.test(value);
export function savePendingFollow(input:{matchId:string;decisionId?:string;returnTo:string},storage:Storage=sessionStorage):PendingFollow{
  if(!validIdentity(input.matchId)||(input.decisionId!==undefined&&!validIdentity(input.decisionId)))throw new Error('比赛标识无效，请返回赛程重新选择。');
  const pending:PendingFollow={matchId:input.matchId,...(input.decisionId?{decisionId:input.decisionId}:{}),returnTo:safeAccountReturnTo(input.returnTo),createdAt:Date.now(),intentId:crypto.randomUUID()};
  storage.setItem(PENDING_KEY,JSON.stringify(pending));return pending;
}
export function readPendingFollow(storage?:Storage,now=Date.now()):PendingFollow|null{
  try{
    const value=JSON.parse((storage??sessionStorage).getItem(PENDING_KEY)||'null') as PendingFollow|null;
    if(!value||!validIdentity(value.matchId)||(value.decisionId!==undefined&&!validIdentity(value.decisionId))||!validIdentity(value.intentId)||!Number.isFinite(value.createdAt)||now-value.createdAt>30*60000||value.createdAt>now+10000)return null;
    return {...value,returnTo:safeAccountReturnTo(value.returnTo)};
  }catch{return null;}
}
export function clearPendingFollow(intentId?:string,storage?:Storage){try{const target=storage??sessionStorage,current=readPendingFollow(target);if(!intentId||current?.intentId===intentId)target.removeItem(PENDING_KEY);}catch{/* Optional storage must not prevent navigation. */}}
export function followGroup(row:FollowRow,now=Date.now()):'upcoming'|'pending'|'settled'{
  if(['WON','LOST','VOID','FINISHED'].includes(row.result?.state||'')||['FINISHED','SETTLED','VOID','CANCELLED'].includes(row.result?.status||''))return 'settled';
  const kickoff=Date.parse(row.kickoffTime);
  return Number.isFinite(kickoff)&&kickoff>now?'upcoming':'pending';
}
export function filterFollowing(rows:FollowRow[],query:string,group:string,now=Date.now()){
  const needle=query.trim().normalize('NFKC').toLocaleLowerCase();
  return rows.filter(row=>(group==='all'||followGroup(row,now)===group)&&(!needle||[row.homeTeamName,row.awayTeamName,row.sourceMatchId||''].some(value=>value.normalize('NFKC').toLocaleLowerCase().includes(needle))));
}
