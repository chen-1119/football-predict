import React from 'react';
import { useApp } from '../context/AppContext';
import { Globe, LogOut, User as UserIcon, HelpCircle } from 'lucide-react';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  openGlossary: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, setCurrentTab, openGlossary }) => {
  const { language, setLanguage, currentUser, isPremium, togglePremium, logout } = useApp();

  const handleTabClick = (tab: string) => {
    setCurrentTab(tab);
  };

  const translations = {
    brand: { zh: 'AI 足球预测', en: 'AI Predict' },
    bestTips: { zh: '每日稳胆', en: 'Best Tips' },
    predictions: { zh: '足球预测', en: 'Predictions' },
    generator: { zh: '投注单生成器', en: 'Bet Generator' },
    hitAndWin: { zh: '命中赢奖', en: 'Hit & Win' },
    login: { zh: '登录/注册', en: 'Login/Register' },
    premium: { zh: '高级会员', en: 'Premium' },
    free: { zh: '免费版', en: 'Free Mode' },
    togglePrem: { zh: '模拟订阅', en: 'Simulate Pro' },
    help: { zh: '术语', en: 'Glossary' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  return (
    <header className="glass-header">
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '70px' }}>
        
        {/* Brand Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }} onClick={() => handleTabClick('predictions')}>
          <div style={{
            background: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 100%)',
            width: '36px', height: '36px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: '800', color: '#000', fontSize: '1.25rem', fontFamily: 'var(--font-title)'
          }}>
            Ω
          </div>
          <span className="primary-gradient-text" style={{ fontSize: '1.4rem', letterSpacing: '-0.5px' }}>
            {t('brand')}
          </span>
        </div>

        {/* Navigation Items */}
        <nav style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button 
            className={`tab-btn ${currentTab === 'best' ? 'active' : ''}`}
            onClick={() => handleTabClick('best')}
          >
            {t('bestTips')}
          </button>
          <button 
            className={`tab-btn ${currentTab === 'predictions' ? 'active' : ''}`}
            onClick={() => handleTabClick('predictions')}
          >
            {t('predictions')}
          </button>
          <button 
            className={`tab-btn ${currentTab === 'generator' ? 'active' : ''}`}
            onClick={() => handleTabClick('generator')}
          >
            {t('generator')}
          </button>
          <button 
            className={`tab-btn ${currentTab === 'hitwin' ? 'active' : ''}`}
            onClick={() => handleTabClick('hitwin')}
          >
            {t('hitAndWin')}
          </button>
        </nav>

        {/* Right Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {/* Glossary trigger */}
          <button 
            onClick={openGlossary} 
            className="btn btn-secondary" 
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
          >
            <HelpCircle size={14} />
            <span>{t('help')}</span>
          </button>

          {/* Language Switcher */}
          <button 
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="btn btn-secondary"
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
          >
            <Globe size={14} />
            <span>{language === 'zh' ? 'EN' : '中文'}</span>
          </button>

          {/* Premium Debug Switch */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: 'hsl(var(--bg-card))', border: '1px solid hsl(var(--border))', borderRadius: '10px', padding: '0.25rem 0.5rem' }}>
            <span className={`badge ${isPremium ? 'badge-premium' : 'badge-success'}`} style={{ fontSize: '0.7rem' }}>
              {isPremium ? t('premium') : t('free')}
            </span>
            <button 
              onClick={togglePremium} 
              className="btn btn-primary" 
              style={{
                padding: '0.25rem 0.5rem', 
                fontSize: '0.7rem', 
                background: isPremium ? 'transparent' : 'hsl(var(--premium))',
                border: isPremium ? '1px solid hsl(var(--border))' : 'none',
                color: isPremium ? 'hsl(var(--text-secondary))' : '#3b2203'
              }}
            >
              {t('togglePrem')}
            </button>
          </div>

          {/* Auth Button / Profile */}
          {currentUser ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.85rem' }}>
                <UserIcon size={14} />
                <span>{currentUser.username}</span>
              </div>
              <button onClick={logout} className="btn btn-secondary" style={{ padding: '0.4rem 0.5rem' }} title="Logout">
                <LogOut size={14} />
              </button>
            </div>
          ) : (
            <button onClick={() => handleTabClick('auth')} className="btn btn-accent" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
              {t('login')}
            </button>
          )}
        </div>

      </div>
    </header>
  );
};
