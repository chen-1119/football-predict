import React from 'react';
import {
  Globe,
  HelpCircle,
  ListChecks,
  LogOut,
  ShieldCheck,
  Target,
  Ticket,
  Trophy,
  User as UserIcon
} from 'lucide-react';
import { useApp } from '../context/AppContextCore';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  openGlossary: () => void;
}

type NavTab = 'best' | 'predictions' | 'generator' | 'hitwin';

const navItems: Array<{
  key: NavTab;
  labelKey: 'bestTips' | 'predictions' | 'generator' | 'hitAndWin';
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { key: 'best', labelKey: 'bestTips', icon: Trophy },
  { key: 'predictions', labelKey: 'predictions', icon: ListChecks },
  { key: 'generator', labelKey: 'generator', icon: Ticket },
  { key: 'hitwin', labelKey: 'hitAndWin', icon: Target }
];

export const Navbar: React.FC<NavbarProps> = ({ currentTab, setCurrentTab, openGlossary }) => {
  const { language, setLanguage, currentUser, isPremium, togglePremium, logout } = useApp();

  const translations = {
    brand: { zh: 'AI 足球预测', en: 'AI Football' },
    subtitle: { zh: '竞彩数据看板', en: 'Prediction Desk' },
    bestTips: { zh: '高可信精选', en: 'Best Tips' },
    predictions: { zh: '赛事预测', en: 'Predictions' },
    generator: { zh: '投注单', en: 'Bet Slip' },
    hitAndWin: { zh: '命中挑战', en: 'Hit & Win' },
    login: { zh: '登录', en: 'Login' },
    premium: { zh: 'PRO', en: 'PRO' },
    free: { zh: '免费版', en: 'Free' },
    togglePrem: { zh: '切换 PRO 预览', en: 'Toggle PRO Preview' },
    help: { zh: '术语', en: 'Glossary' },
    language: { zh: '切换语言', en: 'Switch Language' },
    logout: { zh: '退出登录', en: 'Logout' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const activeTab = currentTab === 'detail' ? 'predictions' : currentTab;

  return (
    <header className="glass-header">
      <div className="container nav-shell">
        <button
          type="button"
          className="brand-button"
          onClick={() => setCurrentTab('predictions')}
          aria-label={t('brand')}
        >
          <span className="brand-mark">AI</span>
          <span className="brand-copy">
            <span className="brand-title">{t('brand')}</span>
            <span className="brand-subtitle">{t('subtitle')}</span>
          </span>
        </button>

        <nav className="nav-links" aria-label="Primary">
          {navItems.map(({ key, labelKey, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={`nav-link ${activeTab === key ? 'active' : ''}`}
              onClick={() => setCurrentTab(key)}
            >
              <Icon size={16} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>

        <div className="nav-actions">
          <button type="button" onClick={openGlossary} className="status-pill" title={t('help')}>
            <HelpCircle size={15} />
            <span>{t('help')}</span>
          </button>

          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="status-pill"
            title={t('language')}
          >
            <Globe size={15} />
            <span>{language === 'zh' ? 'EN' : '中文'}</span>
          </button>

          <button
            type="button"
            onClick={togglePremium}
            className={`status-pill ${isPremium ? 'is-premium' : ''}`}
            title={t('togglePrem')}
          >
            <ShieldCheck size={15} />
            <span>{isPremium ? t('premium') : t('free')}</span>
          </button>

          {currentUser ? (
            <>
              <span className="user-chip" title={currentUser.username}>
                <UserIcon size={15} />
                <span>{currentUser.username}</span>
              </span>
              <button type="button" onClick={logout} className="icon-button" title={t('logout')}>
                <LogOut size={16} />
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setCurrentTab('auth')} className="btn btn-accent">
              <UserIcon size={16} />
              {t('login')}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
