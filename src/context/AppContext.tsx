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

const fetchJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
};

const fetchFirstAvailable = async <T,>(urls: string[]): Promise<T> => {
  let lastError: unknown;

  for (const url of urls) {
    try {
      return await fetchJson<T>(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const mergeMatches = (baseMatches: Match[], nextMatches: Match[]) => {
  const byId = new Map<string, Match>();

  [...baseMatches, ...nextMatches].forEach((match) => {
    byId.set(match.id, match);
  });

  return Array.from(byId.values()).sort((a, b) => new Date(a.kickoffTime).getTime() - new Date(b.kickoffTime).getTime());
};

const registerSyncedMatches = (data: SyncedMatch[]) => {
  data.forEach((m) => {
    if (m.homeTeamId) {
      registerTeam({
        id: m.homeTeamId,
        name: { zh: m.homeTeamName || '未知主队', en: m.homeTeamNameEn || m.homeTeamName || 'Home Team' },
        shortName: { zh: m.homeTeamName || '未知', en: m.homeTeamNameEn || m.homeTeamName || 'Home' },
        logo: m.homeTeamLogo || (m.homeTeamName || 'FC').substring(0, 2),
        logoType: m.homeTeamLogoType,
        value: m.homeTeamValue || '',
        color: m.homeTeamColor || '#7f8c8d'
      });
    }

    if (m.awayTeamId) {
      registerTeam({
        id: m.awayTeamId,
        name: { zh: m.awayTeamName || '未知客队', en: m.awayTeamNameEn || m.awayTeamName || 'Away Team' },
        shortName: { zh: m.awayTeamName || '未知', en: m.awayTeamNameEn || m.awayTeamName || 'Away' },
        logo: m.awayTeamLogo || (m.awayTeamName || 'FC').substring(0, 2),
        logoType: m.awayTeamLogoType,
        value: m.awayTeamValue || '',
        color: m.awayTeamColor || '#95a5a6'
      });
    }

    if (m.leagueId) {
      registerLeague({
        id: m.leagueId,
        name: { zh: m.leagueName || '未知联赛', en: m.leagueNameEn || m.leagueName || 'League' },
        shortName: { zh: m.leagueShortName || m.leagueName || '未知', en: m.leagueShortNameEn || m.leagueNameEn || m.leagueName || 'League' },
        countryId: m.countryId || 'oth',
        isImportant: false
      });
    }

    if (m.countryId) {
      registerCountry({
        id: m.countryId,
        name: { zh: m.countryName || '其他', en: m.countryNameEn || m.countryName || 'Other' },
        flag: m.countryFlag || '🏳️'
      });
    }
  });
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);
  const [currentUser, setCurrentUser] = useState<User | null>(readStoredUser);
  const [isPremium, setIsPremium] = useState<boolean>(() => currentUser?.isPremium ?? false);
  const [dailySlipCount, setDailySlipCount] = useState<number>(readStoredDailySlipCount);
  const [hitAndWinSubmission, setHitAndWinSubmission] = useState<HitAndWinSubmission | null>(readStoredHitAndWinSubmission);
  const [matches, setMatches] = useState<Match[]>(matchesPool);

  // 先加载当前赛程，历史赛果后台补齐；队名保持中国竞彩网同步值，不做别名覆盖。
  useEffect(() => {
    let cancelled = false;

    const applyData = (data: unknown, mode: 'replace' | 'append') => {
      if (cancelled) return;

      try {
        if (isSyncedMatchArray(data) && data.length > 0) {
          registerSyncedMatches(data);
          setMatches((current) => (mode === 'replace' ? data : mergeMatches(current, data)));
        }
      } catch (error: unknown) {
        console.error(error);
        alert(`Data Processing Error:\n${formatError(error)}`);
      }
    };

    fetchFirstAvailable<unknown>(['./data/matches-current.json', './matches.json'])
      .then((data) => {
        applyData(data, 'replace');

        window.setTimeout(() => {
          fetchJson<unknown>('./data/matches-history.json')
            .then((historyData) => applyData(historyData, 'append'))
            .catch((error: unknown) => {
              console.warn('History data is unavailable; current matches remain usable.', error);
            });
        }, 250);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        alert(`Fetch Error:\n${formatError(error)}`);
        // 降级使用静态 mock 引擎数据
        console.log('Using static fallback matchesPool data.');
      });

    return () => {
      cancelled = true;
    };
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
