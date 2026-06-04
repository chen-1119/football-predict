import { createContext, useContext } from 'react';
import type { Match } from '../services/mockData';

export type Language = 'zh' | 'en';
export type HitAndWinPick = '1' | 'X' | '2';
export type HitAndWinSubmission = Record<string, HitAndWinPick>;

export interface User {
  username: string;
  isPremium: boolean;
}

export interface AppContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
  isPremium: boolean;
  togglePremium: () => void;
  dailySlipCount: number;
  incrementSlipCount: () => boolean;
  hitAndWinSubmission: HitAndWinSubmission | null;
  submitHitAndWin: (selections: HitAndWinSubmission) => boolean;
  login: (username: string) => void;
  register: (username: string) => void;
  logout: () => void;
  matches: Match[];
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
