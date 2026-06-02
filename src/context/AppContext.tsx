import React, { createContext, useContext, useState, useEffect } from 'react';
import type { Match } from '../services/mockData';
import { matchesPool, teams, leagues, countries } from '../services/mockData';

export type Language = 'zh' | 'en';

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
  incrementSlipCount: () => boolean; // 返回是否成功（如果超出额度返回 false）
  hitAndWinSubmission: { [matchId: string]: string } | null; // 记录今天的竞猜：{ matchId: '1' | 'X' | '2' }
  submitHitAndWin: (selections: { [matchId: string]: string }) => boolean;
  login: (username: string) => void;
  register: (username: string) => void;
  logout: () => void;
  matches: Match[];
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('zh');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isPremium, setIsPremium] = useState<boolean>(false);
  const [dailySlipCount, setDailySlipCount] = useState<number>(0);
  const [hitAndWinSubmission, setHitAndWinSubmission] = useState<{ [matchId: string]: string } | null>(null);
  const [matches, setMatches] = useState<Match[]>(matchesPool);

  // 从 matches.json 加载数据并动态扩展球队、联赛、国家列表
  useEffect(() => {
    fetch(`./matches.json?t=${Date.now()}`)
      .then(res => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then((data: Match[]) => {
        if (Array.isArray(data) && data.length > 0) {
          // 动态注册抓取到的真实球队、联赛及国家，保证前端UI组件能正常获取信息且不会因空对象红屏崩溃
          data.forEach((m: any) => {
            if (m.homeTeamId && !teams.some(t => t.id === m.homeTeamId)) {
              teams.push({
                id: m.homeTeamId,
                name: { zh: m.homeTeamName || '未知主队', en: m.homeTeamNameEn || 'Home Team' },
                shortName: { zh: m.homeTeamName || '未知', en: m.homeTeamNameEn || 'Home' },
                logo: (m.homeTeamName || 'FC').substring(0, 2),
                value: '50M €',
                color: m.homeTeamColor || '#7f8c8d'
              });
            }
            if (m.awayTeamId && !teams.some(t => t.id === m.awayTeamId)) {
              teams.push({
                id: m.awayTeamId,
                name: { zh: m.awayTeamName || '未知客队', en: m.awayTeamNameEn || 'Away Team' },
                shortName: { zh: m.awayTeamName || '未知', en: m.awayTeamNameEn || 'Away' },
                logo: (m.awayTeamName || 'FC').substring(0, 2),
                value: '50M €',
                color: m.awayTeamColor || '#95a5a6'
              });
            }
            if (m.leagueId && !leagues.some(l => l.id === m.leagueId)) {
              leagues.push({
                id: m.leagueId,
                name: { zh: m.leagueName || '未知联赛', en: m.leagueNameEn || 'League' },
                shortName: { zh: m.leagueShortName || m.leagueName || '未知', en: m.leagueShortNameEn || m.leagueNameEn || 'League' },
                countryId: m.countryId || 'oth',
                isImportant: false
              });
            }
            if (m.countryId && !countries.some(c => c.id === m.countryId)) {
              countries.push({
                id: m.countryId,
                name: { zh: m.countryName || '其他', en: m.countryNameEn || 'Other' },
                flag: m.countryFlag || '🏳️'
              });
            }
          });
          setMatches(data);
        }
      })
      .catch(() => {
        // 降级使用静态 mock 引擎数据
        console.log('Using static fallback matchesPool data.');
      });
  }, []);

  // 从 localStorage 恢复状态
  useEffect(() => {
    const savedLang = localStorage.getItem('nerdy_lang');
    if (savedLang === 'zh' || savedLang === 'en') {
      setLanguageState(savedLang);
    }
    const savedUser = localStorage.getItem('nerdy_user');
    if (savedUser) {
      try {
        const u = JSON.parse(savedUser) as User;
        setCurrentUser(u);
        setIsPremium(u.isPremium);
      } catch (e) {
        // ignore
      }
    }
    const savedCount = localStorage.getItem('nerdy_slip_count');
    if (savedCount) {
      setDailySlipCount(parseInt(savedCount));
    }
    const savedHW = localStorage.getItem('nerdy_hw_submission');
    if (savedHW) {
      try {
        setHitAndWinSubmission(JSON.parse(savedHW));
      } catch (e) {}
    }
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

  const submitHitAndWin = (selections: { [matchId: string]: string }): boolean => {
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

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
