import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AccountApiError, accountRequest, clearPendingFollow, emptyAccountAccess, readPendingFollow } from '../services/accountApi';
import type { AccountSession, FollowRow } from '../services/accountApi';

interface AccountContextValue extends Omit<AccountSession,'ok'|'csrfToken'> {
  loading:boolean; sessionError:string|null; following:FollowRow[]; followingLoading:boolean; followingError:string|null;
  refresh:()=>Promise<AccountSession>; login:(username:string,password:string)=>Promise<void>; register:(username:string,password:string,displayName?:string)=>Promise<string>;
  recoverPassword:(username:string,recoveryCode:string,newPassword:string)=>Promise<string>;
  logout:()=>Promise<void>; claimTrial:()=>Promise<void>; redeemCode:(code:string)=>Promise<void>; revokeOtherSessions:()=>Promise<number>;
  refreshFollowing:()=>Promise<void>; followMatch:(matchId:string,decisionId?:string)=>Promise<FollowRow>; unfollowMatch:(id:string)=>Promise<void>; isFollowing:(matchId:string)=>boolean;
  resumePendingFollow:()=>Promise<boolean>;
  accountAction:<T>(path:string,body?:unknown,method?:string)=>Promise<T>;
}
const AccountContext=createContext<AccountContextValue|null>(null);
const anonymous:AccountSession={ok:true,user:null,access:emptyAccountAccess,authMethods:{password:false,sms:false},csrfToken:''};
export function AccountProvider({children}:{children:ReactNode}){
  const [session,setSession]=useState<AccountSession>(anonymous),[loading,setLoading]=useState(true),[sessionError,setSessionError]=useState<string|null>(null);
  const [following,setFollowing]=useState<FollowRow[]>([]),[followingLoading,setFollowingLoading]=useState(false),[followingError,setFollowingError]=useState<string|null>(null);
  const current=useRef(session),generation=useRef(0),refreshSequence=useRef(0),followRevision=useRef(0),pendingOperation=useRef<Promise<boolean>|null>(null);
  const apply=useCallback((next:AccountSession)=>{
    if(current.current.user?.id!==next.user?.id){generation.current++;setFollowing([]);setFollowingError(null);}
    current.current=next;setSession(next);setSessionError(null);
  },[]);
  const handleError=useCallback((error:unknown)=>{
    if(error instanceof AccountApiError&&current.current.user&&((error.status===401&&(!error.code||/authentication_required|session_expired/.test(error.code)))||(error.status===403&&/blocked|suspended/.test(error.code)))){apply(anonymous);setSessionError('登录已失效，请重新登录。');}
    throw error;
  },[apply]);
  const refresh=useCallback(async()=>{
    const sequence=++refreshSequence.current;
    try{const next=await accountRequest<AccountSession>('/me');if(sequence===refreshSequence.current)apply(next);return next;}
    catch(error){if(sequence===refreshSequence.current){if(error instanceof AccountApiError&&(error.status===401||error.status===403))apply(anonymous);setSessionError(error instanceof Error?error.message:'账号状态读取失败。');}throw error;}
    finally{if(sequence===refreshSequence.current)setLoading(false);}
  },[apply]);
  const mutate=useCallback(async<T,>(path:string,body:unknown={},method='POST'):Promise<T>=>{
    const base=current.current.csrfToken?current.current:await refresh();
    if(!base.csrfToken)throw new Error('账号验证尚未就绪，请刷新后重试。');
    try{return await accountRequest<T>(path,{method,body,csrfToken:base.csrfToken});}catch(error){return handleError(error);}
  },[refresh,handleError]);
  const refreshFollowing=useCallback(async()=>{
    if(!current.current.user){setFollowing([]);return;}
    const stamp=generation.current,revision=followRevision.current;setFollowingLoading(true);
    try{const response=await accountRequest<{rows:FollowRow[]}>('/follows');if(stamp===generation.current&&revision===followRevision.current){setFollowing(response.rows);setFollowingError(null);}}
    catch(error){if(stamp===generation.current){setFollowingError(error instanceof Error?error.message:'关注列表读取失败。');if(error instanceof AccountApiError&&error.status===401)apply(anonymous);}}
    finally{if(stamp===generation.current)setFollowingLoading(false);}
  },[apply]);
  useEffect(()=>{void refresh().catch(()=>{});},[refresh]);
  useEffect(()=>{if(session.user)void refreshFollowing();else{setFollowing([]);setFollowingLoading(false);}},[session.user?.id,refreshFollowing]);
  useEffect(()=>{const wake=()=>{if(document.visibilityState!=='hidden')void refresh().catch(()=>{});};const timer=window.setInterval(wake,60000);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);return()=>{window.clearInterval(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};},[refresh]);
  useEffect(()=>{if(!session.access.active||!session.access.expiresAt)return;const remaining=Date.parse(session.access.expiresAt)-Date.now();if(!Number.isFinite(remaining))return;const expire=()=>{const latest=current.current;if(latest.access.active&&Date.parse(latest.access.expiresAt||'')<=Date.now()){const next={...latest,access:{...latest.access,active:false}};current.current=next;setSession(next);void refresh().catch(()=>{});}};const timer=window.setTimeout(expire,Math.max(0,Math.min(remaining,2147483647)));return()=>window.clearTimeout(timer);},[session.access.active,session.access.expiresAt,refresh]);
  useEffect(()=>{if(!session.user||!session.sessionExpiresAt)return;const remaining=Date.parse(session.sessionExpiresAt)-Date.now();if(!Number.isFinite(remaining))return;const timer=window.setTimeout(()=>{const latest=current.current;if(latest.user&&Date.parse(latest.sessionExpiresAt||'')<=Date.now()){apply({...anonymous,authMethods:latest.authMethods});setSessionError('登录已失效，请重新登录。');void refresh().catch(()=>{});}},Math.max(0,Math.min(remaining,2147483647)));return()=>window.clearTimeout(timer);},[session.user?.id,session.sessionExpiresAt,apply,refresh]);
  const updateSession=useCallback(async(path:string,body:unknown={})=>{const next=await mutate<AccountSession>(path,body);refreshSequence.current++;apply(next);setLoading(false);},[mutate,apply]);
  const login=useCallback((username:string,password:string)=>updateSession('/login',{username:username.trim(),password}),[updateSession]);
  const register=useCallback(async(username:string,password:string,displayName?:string)=>{const next=await mutate<AccountSession&{recoveryCode:string}>('/register',{username:username.trim(),password,...(displayName?.trim()?{displayName:displayName.trim()}:{})});const {recoveryCode,...profile}=next;refreshSequence.current++;apply(profile);setLoading(false);return recoveryCode;},[mutate,apply]);
  const recoverPassword=useCallback(async(username:string,recoveryCode:string,newPassword:string)=>{const result=await mutate<{recoveryCode:string}>('/recover',{username:username.trim(),recoveryCode:recoveryCode.trim(),newPassword});refreshSequence.current++;apply(anonymous);await refresh().catch(()=>{});return result.recoveryCode;},[mutate,apply,refresh]);
  const logout=useCallback(async()=>{await mutate('/logout');refreshSequence.current++;apply(anonymous);clearPendingFollow();await refresh().catch(()=>{});},[mutate,apply,refresh]);
  const claimTrial=useCallback(()=>updateSession('/trial'),[updateSession]);
  const redeemCode=useCallback((code:string)=>updateSession('/redeem',{code}),[updateSession]);
  const revokeOtherSessions=useCallback(async()=>{const result=await mutate<{revoked:number}>('/sessions/revoke-others');return result.revoked;},[mutate]);
  const followMatch=useCallback(async(matchId:string,decisionId?:string)=>{
    const stamp=generation.current;
    const result=await mutate<{row:FollowRow}>('/follows',{matchId,...(decisionId?{decisionId}:{})});
    if(stamp===generation.current){followRevision.current++;setFollowing(rows=>[result.row,...rows.filter(row=>row.id!==result.row.id&&row.matchId!==result.row.matchId)]);}
    return result.row;
  },[mutate]);
  const unfollowMatch=useCallback(async(id:string)=>{const stamp=generation.current;await mutate(`/follows/${encodeURIComponent(id)}`,undefined,'DELETE');if(stamp===generation.current){followRevision.current++;setFollowing(rows=>rows.filter(row=>row.id!==id));}},[mutate]);
  const resumePendingFollow=useCallback(()=>{
    if(pendingOperation.current)return pendingOperation.current;
    const pending=readPendingFollow();if(!pending||!current.current.user)return Promise.resolve(false);
    pendingOperation.current=followMatch(pending.matchId,pending.decisionId).then(()=>{clearPendingFollow(pending.intentId);return true;}).finally(()=>{pendingOperation.current=null;});
    return pendingOperation.current;
  },[followMatch]);
  const value=useMemo<AccountContextValue>(()=>({user:session.user,access:session.access,authMethods:session.authMethods,loading,sessionError,following,followingLoading,followingError,refresh,login,register,recoverPassword,logout,claimTrial,redeemCode,revokeOtherSessions,refreshFollowing,followMatch,unfollowMatch,isFollowing:matchId=>following.some(row=>row.matchId===matchId),resumePendingFollow,accountAction:mutate}),[session,loading,sessionError,following,followingLoading,followingError,refresh,login,register,recoverPassword,logout,claimTrial,redeemCode,revokeOtherSessions,refreshFollowing,followMatch,unfollowMatch,resumePendingFollow,mutate]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
export function useAccount(){const value=useContext(AccountContext);if(!value)throw new Error('AccountProvider is required.');return value;}
