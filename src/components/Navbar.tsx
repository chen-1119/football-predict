import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  CircleUserRound,
  Globe,
  HelpCircle,
  LayoutGrid,
  ListChecks,
  LogOut,
  MoreHorizontal,
  Radio,
  Shield,
  Target,
  User as UserIcon
} from 'lucide-react';
import { useApp } from '../context/AppContextCore';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  openGlossary: () => void;
}

type NavTab = 'predictions' | 'fixtures' | 'arena' | 'review' | 'leagues';
type DataStatus = 'locked' | 'ready' | 'syncing' | 'watch' | 'error';

const navItems: Array<{
  key: NavTab;
  labelKey: 'todayAnalysis' | 'fixtures' | 'arena' | 'review' | 'topLeagues';
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { key: 'predictions', labelKey: 'todayAnalysis', icon: ListChecks },
  { key: 'fixtures', labelKey: 'fixtures', icon: CalendarDays },
  { key: 'review', labelKey: 'review', icon: BookOpen },
  { key: 'arena', labelKey: 'arena', icon: Target },
  { key: 'leagues', labelKey: 'topLeagues', icon: Shield }
];

const finiteDate = (value: string | undefined) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

export const Navbar: React.FC<NavbarProps> = ({ currentTab, setCurrentTab, openGlossary }) => {
  const { language, setLanguage, currentUser, logout, dataSync } = useApp();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const moreRootRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const translations = {
    topLeagues: { zh: '联赛', en: 'Leagues' },
    brand: { zh: '90分钟足球', en: '90’ Football' },
    subtitle: { zh: '赛程 · 数据 · 分析', en: 'Fixtures · Data · Analysis' },
    todayAnalysis: { zh: '分析', en: 'Analysis' },
    fixtures: { zh: '赛程', en: 'Fixtures' },
    arena: { zh: '策略', en: 'Strategy' },
    review: { zh: '复盘', en: 'Review' },
    more: { zh: '更多', en: 'More' },
    moreMenu: { zh: '更多功能', en: 'More options' },
    tools: { zh: '分析工具', en: 'Analysis tools' },
    login: { zh: '校验', en: 'Verify' },
    account: { zh: '当前账户', en: 'Current account' },
    help: { zh: '术语说明', en: 'Glossary' },
    language: { zh: '切换为 English', en: '切换为中文' },
    logout: { zh: '退出校验', en: 'Clear access' },
    primary: { zh: '主导航', en: 'Primary navigation' },
    mobilePrimary: { zh: '移动端主导航', en: 'Mobile primary navigation' },
    dataStatus: { zh: '数据状态', en: 'Data status' },
    dataLocked: { zh: '待校验', en: 'Verify first' },
    dataReady: { zh: '实时在线', en: 'Live' },
    dataSyncing: { zh: '同步中', en: 'Syncing' },
    dataWatch: { zh: '数据待核', en: 'Data notice' },
    dataError: { zh: '数据异常', en: 'Data issue' },
    dataPublishing: { zh: '发布切换', en: 'Publishing' },
    dataRetrying: { zh: '同步重试', en: 'Retrying' },
    dataIntegrity: { zh: '完整性待核', en: 'Integrity check' },
    dataStale: { zh: '更新滞后', en: 'Delayed' },
    dataEvidence: { zh: '模型影子', en: 'Model shadow' },
    dataFallback: { zh: '降级读取', en: 'Fallback' },
    dataLoading: { zh: '读取赛程', en: 'Loading' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const activeTab = currentTab === 'detail' ? 'fixtures' : currentTab;
  const toolsActive = currentTab === 'tools' || currentTab === 'best' || currentTab === 'generator';
  const publicationTransition = [
    'generation-sqlite-mismatch',
    'generation-pair-refresh',
    'generation-sqlite-replacement',
    'sqlite-previous-pair',
    'previous-generation',
    'generation-previous'
  ].includes(dataSync.healthCurrentReadSource || '');
  const visibleScheduleRetained = dataSync.currentLoaded && dataSync.currentCount > 0;

  const dataStatus: DataStatus = (() => {
    if (!currentUser) return 'locked';
    if ((publicationTransition || dataSync.serviceTransitioning) && visibleScheduleRetained) return 'syncing';
    if (dataSync.error && !visibleScheduleRetained) return 'error';
    if ((dataSync.sourceHealthOk === false || dataSync.serviceDataFresh === false) && !visibleScheduleRetained) return 'error';
    if (dataSync.currentLoading || !dataSync.currentLoaded) return 'syncing';
    if (
      dataSync.error
      || dataSync.sourceHealthOk === false
      || dataSync.serviceDataFresh === false
      || dataSync.sourceStale
      || dataSync.sourceDataFresh === false
      || dataSync.recommendationReliable === false
      || dataSync.healthServingMode === 'fallback-degraded'
    ) return 'watch';
    return 'ready';
  })();

  const dataStatusLabel = {
    locked: t('dataLocked'), ready: t('dataReady'), syncing: t('dataSyncing'), watch: t('dataWatch'), error: t('dataError')
  }[dataStatus];

  const dataStatusDetail = (() => {
    if (publicationTransition || dataSync.serviceTransitioning) return t('dataPublishing');
    if (dataSync.error) return t('dataRetrying');
    if (dataSync.sourceHealthOk === false) return t('dataIntegrity');
    if (dataSync.serviceDataFresh === false || dataSync.sourceStale || dataSync.sourceDataFresh === false) return t('dataStale');
    if (dataSync.recommendationReliable === false) return t('dataEvidence');
    if (dataSync.healthServingMode === 'fallback-degraded') return t('dataFallback');
    if (dataSync.currentLoading || !dataSync.currentLoaded) return t('dataLoading');
    return '';
  })();

  const latestActivityAt = Math.max(
    finiteDate(dataSync.lastServerEventAt) || 0,
    finiteDate(dataSync.lastCheckedAt) || 0,
    finiteDate(dataSync.sourceUpdatedAt) || 0
  );
  const activityAgeSeconds = latestActivityAt > 0 ? Math.max(0, Math.round((clockNow - latestActivityAt) / 1000)) : null;
  const transportLabel = dataSync.liveUpdates === 'sse'
    ? 'SSE'
    : dataSync.refreshIntervalSeconds
      ? `${Math.round(dataSync.refreshIntervalSeconds)}s`
      : 'POLL';
  const countLabel = dataSync.currentLoaded ? `${dataSync.currentCount}` : '--';
  const freshnessLabel = activityAgeSeconds === null
    ? '--'
    : activityAgeSeconds < 60
      ? `${activityAgeSeconds}s`
      : `${Math.floor(activityAgeSeconds / 60)}m`;
  const dataStatusReadable = dataStatus !== 'ready' && dataStatus !== 'locked';
  const dataStatusDisplayLabel = dataStatusReadable && dataStatusDetail
    ? `${dataStatusLabel} · ${dataStatusDetail}`
    : dataStatusLabel;
  const dataStatusTitle = [
    t('dataStatus'),
    dataStatusLabel,
    dataStatusDetail,
    `${language === 'zh' ? '通道' : 'transport'} ${transportLabel}`,
    `${language === 'zh' ? '场次' : 'fixtures'} ${countLabel}`,
    `${language === 'zh' ? '活动' : 'activity'} ${freshnessLabel}`,
    dataSync.lastServerEventType || ''
  ].filter(Boolean).join(' · ');

  const closeMore = useCallback((restoreFocus = false) => {
    setIsMoreOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => moreTriggerRef.current?.focus());
  }, []);

  const focusMenuItem = useCallback((index: number) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (!items.length) return;
    const wrappedIndex = (index + items.length) % items.length;
    items[wrappedIndex]?.focus();
  }, []);

  useEffect(() => {
    if (!isMoreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!moreRootRef.current?.contains(event.target as Node)) closeMore();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMore(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMore, isMoreOpen]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusMenuItem(currentIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusMenuItem(currentIndex - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusMenuItem(0); }
    else if (event.key === 'End') { event.preventDefault(); focusMenuItem(-1); }
    else if (event.key === 'Tab') closeMore();
  };

  const selectFromMenu = (action: () => void) => {
    closeMore();
    action();
  };

  const renderPrimaryNavigation = (mobile = false) => (
    <nav className={mobile ? 'app-mobile-tabbar' : 'app-primary-nav'} aria-label={mobile ? t('mobilePrimary') : t('primary')}>
      {navItems.map(({ key, labelKey, icon: Icon }) => {
        const isActive = activeTab === key;
        return (
          <button key={key} type="button" className={`${mobile ? 'app-mobile-tab' : 'app-nav-item'} ${isActive ? 'is-active' : ''}`}
            aria-current={isActive ? 'page' : undefined} onClick={() => setCurrentTab(key)}>
            <Icon size={mobile ? 19 : 16} strokeWidth={isActive ? 2.35 : 1.9} />
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <>
      <header className="app-topbar">
        <div className="container app-topbar-inner">
          <button type="button" className="app-brand" onClick={() => setCurrentTab('predictions')} aria-label={t('brand')}>
            <span className="app-brand-mark" aria-hidden="true">90</span>
            <span className="app-brand-copy">
              <span className="app-brand-title">{t('brand')}</span>
              <span className="app-brand-subtitle">{t('subtitle')}</span>
            </span>
          </button>

          {renderPrimaryNavigation()}

          <div className="app-topbar-actions">
            <span className={`app-data-status is-${dataStatus} ${dataStatusReadable ? 'is-readable' : ''}`}
              role="status" aria-live="polite" aria-label={dataStatusTitle} title={dataStatusTitle}>
              <span className="app-data-status-dot" aria-hidden="true" />
              <span>{dataStatusDisplayLabel}</span>
              {currentUser && <span className="app-data-status-live-meta" aria-hidden="true">
                <Radio size={11} /> {transportLabel} · {countLabel} · {freshnessLabel}
              </span>}
            </span>

            <div className="app-more" ref={moreRootRef}>
              <button ref={moreTriggerRef} type="button" className={`app-more-trigger ${isMoreOpen || toolsActive ? 'is-active' : ''}`}
                aria-label={t('moreMenu')} aria-haspopup="menu" aria-expanded={isMoreOpen} aria-controls="app-more-menu"
                onClick={() => setIsMoreOpen((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setIsMoreOpen(true); window.requestAnimationFrame(() => focusMenuItem(0)); }
                  else if (event.key === 'ArrowUp') { event.preventDefault(); setIsMoreOpen(true); window.requestAnimationFrame(() => focusMenuItem(-1)); }
                }}>
                <MoreHorizontal size={18} />
                <span>{t('more')}</span>
                <ChevronDown className="app-more-chevron" size={14} aria-hidden="true" />
              </button>

              {isMoreOpen && (
                <div id="app-more-menu" className="app-more-menu" role="menu" aria-label={t('moreMenu')} onKeyDown={handleMenuKeyDown}>
                  {currentUser && <div className="app-more-account" aria-label={t('account')}>
                    <CircleUserRound size={18} />
                    <span><small>{t('account')}</small><strong>{currentUser.username}</strong></span>
                  </div>}
                  <button ref={(node) => { menuItemRefs.current[0] = node; }} type="button" role="menuitem"
                    className={toolsActive ? 'is-active' : undefined} onClick={() => selectFromMenu(() => setCurrentTab('tools'))}>
                    <LayoutGrid size={17} /><span>{t('tools')}</span>
                  </button>
                  <button ref={(node) => { menuItemRefs.current[1] = node; }} type="button" role="menuitem" onClick={() => selectFromMenu(openGlossary)}>
                    <HelpCircle size={17} /><span>{t('help')}</span>
                  </button>
                  <button ref={(node) => { menuItemRefs.current[2] = node; }} type="button" role="menuitem"
                    onClick={() => selectFromMenu(() => setLanguage(language === 'zh' ? 'en' : 'zh'))}>
                    <Globe size={17} /><span>{t('language')}</span>
                  </button>
                  {currentUser && <button ref={(node) => { menuItemRefs.current[3] = node; }} type="button" role="menuitem" className="is-danger"
                    onClick={() => selectFromMenu(logout)}><LogOut size={17} /><span>{t('logout')}</span></button>}
                </div>
              )}
            </div>

            {currentUser ? (
              <span className="app-account-chip" title={currentUser.username} aria-label={`${t('account')}：${currentUser.username}`}>
                <UserIcon size={16} /><span>{currentUser.username}</span>
              </span>
            ) : (
              <button type="button" className="app-account-button" onClick={() => setCurrentTab('auth')}>
                <UserIcon size={16} /><span>{t('login')}</span>
              </button>
            )}
          </div>
        </div>
      </header>
      {renderPrimaryNavigation(true)}
    </>
  );
};
