import React, { useState, useEffect } from 'react';
import type { Match } from '../services/mockData';
import { matchesPool, registerTeam, registerLeague, registerCountry } from '../services/mockData';
import { AppContext } from './AppContextCore';
import type { HitAndWinSubmission, Language, User } from './AppContextCore';

type SyncedMatch = Match & {
  homeTeamName?: string;
  homeTeamNameEn?: string;
  homeTeamLogo?: string;
  homeTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
  homeTeamColor?: string;
  awayTeamName?: string;
  awayTeamNameEn?: string;
  awayTeamLogo?: string;
  awayTeamLogoType?: 'flag' | 'crest' | 'crest-placeholder';
  awayTeamColor?: string;
  leagueName?: string;
  leagueNameEn?: string;
  leagueShortName?: string;
  leagueShortNameEn?: string;
  countryName?: string;
  countryNameEn?: string;
  countryFlag?: string;
  homeTeamValue?: string;
  awayTeamValue?: string;
};

const readStoredLanguage = (): Language => {
  const savedLang = localStorage.getItem('nerdy_lang');
  return savedLang === 'zh' || savedLang === 'en' ? savedLang : 'zh';
};

const readJsonFromStorage = <T,>(key: string): T | null => {
  const savedValue = localStorage.getItem(key);
  if (!savedValue) return null;

  try {
    return JSON.parse(savedValue) as T;
  } catch {
    return null;
  }
};

const readStoredUser = (): User | null => readJsonFromStorage<User>('nerdy_user');

const readStoredDailySlipCount = (): number => {
  const savedCount = Number(localStorage.getItem('nerdy_slip_count'));
  return Number.isFinite(savedCount) ? savedCount : 0;
};

const readStoredHitAndWinSubmission = (): HitAndWinSubmission | null => {
  return readJsonFromStorage<HitAndWinSubmission>('nerdy_hw_submission');
};

const isSyncedMatchArray = (data: unknown): data is SyncedMatch[] => {
  return Array.isArray(data);
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join('\n');
  }
  return String(error);
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);
  const [currentUser, setCurrentUser] = useState<User | null>(readStoredUser);
  const [isPremium, setIsPremium] = useState<boolean>(() => currentUser?.isPremium ?? false);
  const [dailySlipCount, setDailySlipCount] = useState<number>(readStoredDailySlipCount);
  const [hitAndWinSubmission, setHitAndWinSubmission] = useState<HitAndWinSubmission | null>(readStoredHitAndWinSubmission);
  const [matches, setMatches] = useState<Match[]>(matchesPool);

  // 从 matches.json 加载数据并动态扩展球队、联赛、国家列表
  useEffect(() => {
    fetch(`./matches.json?t=${Date.now()}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data: unknown) => {
        try {
          if (isSyncedMatchArray(data) && data.length > 0) {
            // 动态注册抓取到的真实球队、联赛及国家，保证前端UI组件能正常获取信息且不会因空对象红屏崩溃
            data.forEach((m) => {
              if (m.homeTeamId) {
                registerTeam({
                  id: m.homeTeamId,
                  name: { zh: m.homeTeamName || '未知主队', en: m.homeTeamNameEn || 'Home Team' },
                  shortName: { zh: m.homeTeamName || '未知', en: m.homeTeamNameEn || 'Home' },
                  logo: m.homeTeamLogo || (m.homeTeamName || 'FC').substring(0, 2),
                  logoType: m.homeTeamLogoType,
                  value: m.homeTeamValue || '',
                  color: m.homeTeamColor || '#7f8c8d'
                });
              }
              if (m.awayTeamId) {
                registerTeam({
                  id: m.awayTeamId,
                  name: { zh: m.awayTeamName || '未知客队', en: m.awayTeamNameEn || 'Away Team' },
                  shortName: { zh: m.awayTeamName || '未知', en: m.awayTeamNameEn || 'Away' },
                  logo: m.awayTeamLogo || (m.awayTeamName || 'FC').substring(0, 2),
                  logoType: m.awayTeamLogoType,
                  value: m.awayTeamValue || '',
                  color: m.awayTeamColor || '#95a5a6'
                });
              }
              if (m.leagueId) {
                registerLeague({
                  id: m.leagueId,
                  name: { zh: m.leagueName || '未知联赛', en: m.leagueNameEn || 'League' },
                  shortName: { zh: m.leagueShortName || m.leagueName || '未知', en: m.leagueShortNameEn || m.leagueNameEn || 'League' },
                  countryId: m.countryId || 'oth',
                  isImportant: false
                });
              }
              if (m.countryId) {
                registerCountry({
                  id: m.countryId,
                  name: { zh: m.countryName || '其他', en: m.countryNameEn || 'Other' },
                  flag: m.countryFlag || '🏳️'
                });
              }
            });
            setMatches(data);
          }
        } catch (error: unknown) {
          console.error(error);
          alert(`Data Processing Error:\n${formatError(error)}`);
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        alert(`Fetch Error:\n${formatError(error)}`);
        // 降级使用静态 mock 引擎数据
        console.log('Using static fallback matchesPool data.');
      });
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('nerdy_lang', lang);
  };

  const togglePremium = () => {
    const nextPremium = !isPremium;
    setIsPremium(nextPremium);
    if (currentUser) {
      const updatedUser = { ...currentUser, isPremium: nextPremium };
      setCurrentUser(updatedUser);
      localStorage.setItem('nerdy_user', JSON.stringify(updatedUser));
    }
  };

  const incrementSlipCount = (): boolean => {
    if (!isPremium && dailySlipCount >= 1) {
      return false; // 免费限制每天只能生成 1 张
    }
    const nextCount = dailySlipCount + 1;
    setDailySlipCount(nextCount);
    localStorage.setItem('nerdy_slip_count', nextCount.toString());
    return true;
  };

  const submitHitAndWin = (selections: HitAndWinSubmission): boolean => {
    setHitAndWinSubmission(selections);
    localStorage.setItem('nerdy_hw_submission', JSON.stringify(selections));
    return true;
  };

  const login = (username: string) => {
    const u: User = { username, isPremium: false }; // 默认新登录为免费用户
    setCurrentUser(u);
    setIsPremium(false);
    localStorage.setItem('nerdy_user', JSON.stringify(u));
  };

  const register = (username: string) => {
    login(username); // 注册即登录
  };

  const logout = () => {
    setCurrentUser(null);
    setIsPremium(false);
    setDailySlipCount(0);
    setHitAndWinSubmission(null);
    localStorage.removeItem('nerdy_user');
    localStorage.removeItem('nerdy_slip_count');
    localStorage.removeItem('nerdy_hw_submission');
  };

  return (
    <AppContext.Provider value={{
      language,
      setLanguage,
      currentUser,
      setCurrentUser,
      isPremium,
      togglePremium,
      dailySlipCount,
      incrementSlipCount,
      hitAndWinSubmission,
      submitHitAndWin,
      login,
      register,
      logout,
      matches
    }}>
      {children}
    </AppContext.Provider>
  );
};
