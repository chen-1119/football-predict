import { useState } from 'react';
import { Heart, Loader2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAccount } from '../context/AccountContext';
import { useApp } from '../context/AppContextCore';
import { savePendingFollow, safeAccountReturnTo } from '../services/accountApi';
import '../styles/account.css';

export function FollowButton({matchId,decisionId,className='',compact=false}:{matchId:string;decisionId?:string;className?:string;compact?:boolean}){
  const account=useAccount(),{language}=useApp(),navigate=useNavigate(),location=useLocation();
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState('');
  const zh=language==='zh',row=account.following.find(item=>item.matchId===matchId),followed=Boolean(row);
  async function toggle(){
    if(busy)return;
    setError(null);setNotice('');
    if(!account.user){
      const returnTo=safeAccountReturnTo(location.pathname+location.search+location.hash),pendingFollow={matchId,decisionId,returnTo,createdAt:Date.now()};
      try{savePendingFollow(pendingFollow);}catch{/* Router state also carries the action when browser storage is unavailable. */}
      navigate(`/auth?returnTo=${encodeURIComponent(returnTo)}`,{state:{returnTo,pendingFollow}});return;
    }
    setBusy(true);
    try{if(row)await account.unfollowMatch(row.id);else await account.followMatch(matchId,decisionId);setNotice(row?(zh?'已取消关注':'Unfollowed'):(zh?'已加入我的关注':'Added to your following'));}
    catch(cause){setError(cause instanceof Error?cause.message:(zh?'关注未完成，请重试。':'Could not update following.'));}
    finally{setBusy(false);}
  }
  const label=followed?(zh?'已关注':'Following'):(zh?'关注比赛':'Follow match');
  return <span className={`account-follow-wrap ${className}`}><button type="button" className={`account-follow${followed?' is-following':''}${compact?' is-compact':''}`} onClick={toggle} disabled={busy||account.loading||(Boolean(account.user)&&account.followingLoading)} aria-pressed={followed} aria-label={label} title={label}>{busy?<Loader2 size={16} className="account-spin"/>:<Heart size={16} fill={followed?'currentColor':'none'}/>}<span>{label}</span></button>{error&&<span className="account-inline-error" role="alert">{error}</span>}{notice&&<span className="account-sr-only" role="status">{notice}</span>}</span>;
}
