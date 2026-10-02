import { createContext, useContext } from 'react';
import type { AccountSession, FollowRow } from '../services/accountApi';

export interface AccountContextValue extends Omit<AccountSession,'ok'|'csrfToken'> {
  loading:boolean; sessionError:string|null; following:FollowRow[]; followingLoading:boolean; followingError:string|null;
  refresh:()=>Promise<AccountSession>; login:(username:string,password:string)=>Promise<void>; register:(username:string,password:string,displayName?:string)=>Promise<string>;
  recoverPassword:(username:string,recoveryCode:string,newPassword:string)=>Promise<string>;
  logout:()=>Promise<void>; claimTrial:()=>Promise<void>; redeemCode:(code:string)=>Promise<void>; revokeOtherSessions:()=>Promise<number>;
  refreshFollowing:()=>Promise<void>; followMatch:(matchId:string,decisionId?:string)=>Promise<FollowRow>; unfollowMatch:(id:string)=>Promise<void>; isFollowing:(matchId:string)=>boolean;
  resumePendingFollow:()=>Promise<boolean>;
  accountAction:<T>(path:string,body?:unknown,method?:string)=>Promise<T>;
}

export const AccountContext=createContext<AccountContextValue|null>(null);
export function useAccount(){const value=useContext(AccountContext);if(!value)throw new Error('AccountProvider is required.');return value;}
