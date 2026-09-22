import { useRef, useState } from 'react';
import { ArrowRight, Check, Clock, Eye, EyeOff, Heart, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContextCore';
import { useAccount } from '../context/AccountContext';
import { clearPendingFollow, readPendingFollow, safeAccountReturnTo } from '../services/accountApi';
import { formatAccessCode } from '../services/accessControl';
import '../styles/account.css';

interface AuthProps {onSuccess?:()=>void}
export const Auth=({onSuccess}:AuthProps)=>{
  const account=useAccount(),app=useApp(),navigate=useNavigate(),location=useLocation(),zh=app.language==='zh';
  const [mode,setMode]=useState<'login'|'register'|'recover'>('login'),[username,setUsername]=useState(''),[displayName,setDisplayName]=useState(''),[password,setPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState(''),[showPassword,setShowPassword]=useState(false),[recoveryInput,setRecoveryInput]=useState('');
  const [recoveryCode,setRecoveryCode]=useState(''),[recoverySaved,setRecoverySaved]=useState(false),[recovered,setRecovered]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[legacyCode,setLegacyCode]=useState('');
  const fallbackFollowDone=useRef(false);
  const routeState=location.state as {returnTo?:string;from?:{pathname?:string;search?:string;hash?:string};pendingFollow?:{matchId?:string;decisionId?:string;returnTo?:string;createdAt?:number}}|null;
  const requested=new URLSearchParams(location.search).get('returnTo')||routeState?.returnTo||(routeState?.from?.pathname?routeState.from.pathname+(routeState.from.search||'')+(routeState.from.hash||''):null);
  const target=safeAccountReturnTo(requested,'/account');
  async function finish(){
    const pending=readPendingFollow(),fallback=routeState?.pendingFollow;
    if(pending)await account.resumePendingFollow();
    else if(fallback?.matchId&&Number.isFinite(fallback.createdAt)&&Date.now()-(fallback.createdAt||0)>=0&&Date.now()-(fallback.createdAt||0)<=30*60000&&!fallbackFollowDone.current){await account.followMatch(fallback.matchId,fallback.decisionId);fallbackFollowDone.current=true;clearPendingFollow();}
    navigate(requested?target:pending?.returnTo||target,{replace:true});
  }
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy)return;setError('');setNotice('');
    if(mode!=='login'&&password!==confirmPassword){setError(zh?'两次输入的密码不一致。':'The passwords do not match.');return;}
    setBusy(true);
    try{
      if(mode==='register'){const code=await account.register(username,password,displayName);setPassword('');setConfirmPassword('');setRecoveryCode(code);setRecoverySaved(false);setRecovered(false);}
      else if(mode==='recover'){const code=await account.recoverPassword(username,recoveryInput,password);setPassword('');setConfirmPassword('');setRecoveryInput('');setRecoveryCode(code);setRecoverySaved(false);setRecovered(true);}
      else{await account.login(username,password);setPassword('');await finish();}
    }catch(cause){setError(cause instanceof Error?cause.message:(zh?'操作未完成，请重试。':'The action could not be completed.'));}
    finally{setBusy(false);}
  }
  async function continueSignedIn(){setBusy(true);setError('');try{await finish();}catch(cause){setError(cause instanceof Error?cause.message:(zh?'关注尚未完成，请重试。':'Following could not be completed.'));}finally{setBusy(false);}}
  async function saveAndContinue(){
    if(!recoverySaved)return;
    if(recovered){setRecoveryCode('');setMode('login');setNotice(zh?'密码已重置，其他登录已失效，请重新登录。':'Password reset. All sessions were signed out. Please sign in again.');return;}
    setRecoveryCode('');await continueSignedIn();
  }
  async function legacy(event:React.FormEvent){event.preventDefault();setBusy(true);setError('');try{await app.verifyAccessCode(legacyCode);if(onSuccess)onSuccess();else navigate('/best',{replace:true});}catch(cause){setError(cause instanceof Error?cause.message:'校验失败。');}finally{setBusy(false);}}
  const changingPassword=mode==='register'||mode==='recover';
  return <div className="account-page"><div className="account-auth-layout"><section className="account-auth-intro"><span className="account-eyebrow">90 {zh?'分钟足球':'MINUTE FOOTBALL'}</span><h1>{zh?'从关注一场比赛开始':'Start with a match you care about'}</h1><p>{zh?'保存你的关注，回看当时的分析与真实赛果。账号注册后即可使用关注功能。':'Save followed matches and compare the original analysis with actual results. Following is available as soon as you register.'}</p><ul><li><Heart size={19}/>{zh?'跨设备保存关注比赛':'Keep followed matches across devices'}</li><li><ShieldCheck size={19}/>{zh?'当时记录与正式结果分别查看':'Separate saved analysis from official results'}</li><li><Clock size={19}/>{zh?'3 天内容体验，按需主动领取':'Claim a 3-day content trial when ready'}</li></ul><Link className="account-text-link" to="/fixtures">{zh?'先看看今日赛程':'Browse fixtures first'}<ArrowRight size={16}/></Link></section>
      <section className="account-card account-auth-card">
        {error&&<p className="account-error" role="alert">{error}</p>}{notice&&<p className="account-success" role="status">{notice}</p>}
        {recoveryCode?<><div className="account-card-title"><KeyRound size={22}/><h2>{zh?'保存你的恢复码':'Save your recovery code'}</h2></div><p>{zh?'此码仅显示一次。忘记密码时用它恢复账号，请保存在个人密码管理器中，不要分享给他人。':'Shown once. Keep it in your password manager to recover your account, and do not share it.'}</p><code className="account-recovery-code">{recoveryCode}</code><button type="button" className="account-secondary" onClick={async()=>{try{await navigator.clipboard.writeText(recoveryCode);setNotice(zh?'已复制，请保存到安全的位置。':'Copied. Store it somewhere safe.');}catch{setNotice(zh?'无法自动复制，请选中上方恢复码自行复制。':'Select and copy the recovery code above.');}}}>{zh?'复制恢复码':'Copy recovery code'}</button><label className="account-check"><input type="checkbox" checked={recoverySaved} onChange={event=>setRecoverySaved(event.target.checked)}/><span>{zh?'我已保存恢复码':'I have saved my recovery code'}</span></label><button type="button" className="account-primary" disabled={!recoverySaved||busy} onClick={saveAndContinue}>{recovered?(zh?'返回登录':'Return to sign in'):(zh?'保存并继续':'Continue')}<ArrowRight size={16}/></button></>:account.user?<><div className="account-card-title"><Check size={22}/><h2>{zh?'已登录':'Signed in'}</h2></div><p>{account.user.displayName||account.user.username}</p><p>{zh?'继续返回刚才的页面；待处理的关注会一并保存。':'Continue to the previous page and save any pending follow.'}</p><button type="button" className="account-primary" disabled={busy} onClick={continueSignedIn}>{busy?(zh?'正在继续…':'Continuing…'):(zh?'继续':'Continue')}<ArrowRight size={16}/></button><Link className="account-text-link" to="/account">{zh?'管理账号':'Manage account'}</Link></>:<>
          <div className="account-tabs" role="group" aria-label={zh?'账号操作':'Account action'}>{(['login','register'] as const).map(item=><button type="button" key={item} aria-pressed={mode===item} disabled={busy} onClick={()=>{setMode(item);setError('');setPassword('');setConfirmPassword('');}}>{item==='login'?(zh?'登录':'Sign in'):(zh?'注册账号':'Register')}</button>)}</div>
          {mode==='recover'&&<h2>{zh?'使用恢复码重置密码':'Reset with a recovery code'}</h2>}
          {account.sessionError&&<div className="account-error" role="alert"><span>{account.sessionError}</span><button type="button" onClick={()=>account.refresh().catch(()=>{})}>{zh?'重试':'Retry'}</button></div>}
          {!account.loading&&!account.authMethods.password&&!account.sessionError&&<p className="account-error" role="status">{zh?'账号登录暂未开放，请稍后重试，或使用下方已有访问码。':'Account sign-in is unavailable. Try later or use an existing access code below.'}</p>}
          <form className="account-form" onSubmit={submit}><label htmlFor="account-username">{zh?'账号名':'Username'}</label><input id="account-username" value={username} onChange={event=>setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.\-]{3,32}" placeholder={zh?'3–32 位字母、数字或 _ . -':'3–32 letters, digits, _ . -'}/>
            {mode==='register'&&<><label htmlFor="account-display-name">{zh?'显示名称（选填）':'Display name (optional)'}</label><input id="account-display-name" value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={40} autoComplete="nickname" placeholder={zh?'你希望显示的名字':'Your display name'}/></>}
            {mode==='recover'&&<><label htmlFor="account-recovery-input">{zh?'恢复码':'Recovery code'}</label><input id="account-recovery-input" value={recoveryInput} onChange={event=>setRecoveryInput(event.target.value)} autoComplete="off" required spellCheck={false}/></>}
            <label htmlFor="account-password">{mode==='recover'?(zh?'新密码':'New password'):(zh?'密码':'Password')}</label><div className="account-password"><input id="account-password" type={showPassword?'text':'password'} value={password} onChange={event=>setPassword(event.target.value)} autoComplete={changingPassword?'new-password':'current-password'} required minLength={changingPassword?15:undefined} maxLength={128}/><button type="button" aria-label={showPassword?(zh?'隐藏密码':'Hide password'):(zh?'显示密码':'Show password')} onClick={()=>setShowPassword(value=>!value)}>{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</button></div>
            {changingPassword&&<><p className="account-field-hint">{zh?'使用 15–128 个字符，可使用较长的密码短语。':'Use 15–128 characters; a long passphrase works well.'}</p><label htmlFor="account-confirm-password">{zh?'再次输入密码':'Confirm password'}</label><input id="account-confirm-password" type={showPassword?'text':'password'} value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)} autoComplete="new-password" required minLength={15} maxLength={128}/></>}
            <button type="submit" className="account-primary" disabled={busy||account.loading||!account.authMethods.password}>{busy?<Loader2 size={17} className="account-spin"/>:<ArrowRight size={17}/>} {busy?(zh?'正在处理…':'Working…'):mode==='register'?(zh?'创建账号':'Create account'):mode==='recover'?(zh?'重置密码':'Reset password'):(zh?'登录并继续':'Sign in & continue')}</button>
          </form><button type="button" className="account-text-link" disabled={busy} onClick={()=>{setMode(mode==='recover'?'login':'recover');setError('');setPassword('');setConfirmPassword('');}}>{mode==='recover'?(zh?'返回登录':'Back to sign in'):(zh?'忘记密码？使用恢复码':'Forgot password? Use recovery code')}</button>
          <p className="account-note">{zh?'当前使用账号名与密码登录。注册不会自动领取体验，也不会自动订阅或扣费。':'Sign in with a username and password. Registration does not activate a trial, subscription or payment.'}</p>
        </>}
        <details className="account-legacy"><summary>{zh?'原访问码入口（临时权限）':'Original access code (temporary access)'}</summary><p>{zh?'这是独立的旧版临时访问权限，不会创建账号或同步个人关注。':'This provides legacy temporary access. It does not create an account or sync followed matches.'}</p>{account.user?<Link className="account-text-link" to="/account">{zh?'当前已登录，请到我的账号兑换访问码':'Redeem the code in your account'}</Link>:<form className="account-form" onSubmit={legacy}><label htmlFor="legacy-access-code">{zh?'已有访问码':'Existing access code'}</label><input id="legacy-access-code" value={legacyCode} onChange={event=>setLegacyCode(formatAccessCode(event.target.value))} placeholder="XXXX-XXXX-XXXX" autoComplete="off" required/><button type="submit" className="account-secondary" disabled={busy||!legacyCode.trim()}>{zh?'验证原访问码':'Verify original code'}</button></form>}</details>
      </section></div></div>;
};
