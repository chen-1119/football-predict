import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  CircleUserRound,
  Globe,
  HelpCircle,
  Heart,
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
import { useAccount } from '../context/AccountContext';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  openGlossary: () => void;
}

type NavTab = 'best' | 'fixtures' | 'following' | 'review' | 'my';
type DataStatus = 'locked' | 'ready' | 'syncing' | 'watch' | 'error';

const navItems: Array<{
  key: NavTab;
  labelKey: 'todayAnalysis' | 'fixtures' | 'following' | 'review' | 'my';
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { key: 'best', labelKey: 'todayAnalysis', icon: ListChecks },
  { key: 'fixtures', labelKey: 'fixtures', icon: CalendarDays },
  { key: 'following', labelKey: 'following', icon: Heart },
  { key: 'review', labelKey: 'review', icon: BookOpen },
  { key: 'my', labelKey: 'my', icon: CircleUserRound }
];

const finiteDate = (value: string | undefined) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

export const Navbar: React.FC<NavbarProps> = ({ currentTab, setCurrentTab, openGlossary }) => {
  const { language, setLanguage, currentUser, logout: legacyLogout, dataSync, isAccessVerified } = useApp();
  const account = useAccount();
  const [logoutError, setLogoutError] = useState('');
  const logout = () => { void (async () => { try { if (account.user) await account.logout(); legacyLogout(); setCurrentTab('best'); } catch { setLogoutError(language === 'zh' ? '退出未完成，请重试。' : 'Sign out failed. Please retry.'); } })(); };
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const moreRootRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const statusRootRef = useRef<HTMLDivElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const statusPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const translations = {
    topLeagues: { zh: '联赛', en: 'Leagues' },
    brand: { zh: '90分钟足球', en: '90’ Football' },
    subtitle: { zh: '赛程 · 数据 · 分析', en: 'Fixtures · Data · Analysis' },
    todayAnalysis: { zh: '今日', en: 'Today' },
    following: { zh: '关注', en: 'Following' },
    my: { zh: '我的', en: 'My account' },
    matchAnalysis: { zh: '赛前资料', en: 'Pre-match data' },
    fixtures: { zh: '赛程', en: 'Fixtures' },
    arena: { zh: '策略', en: 'Strategy' },
    review: { zh: '复盘', en: 'Review' },
    more: { zh: '更多', en: 'More' },
    moreMenu: { zh: '更多功能', en: 'More options' },
    tools: { zh: '分析工具', en: 'Analysis tools' },
    login: { zh: '登录', en: 'Sign in' },
    account: { zh: '当前账户', en: 'Current account' },
    accountMenu: { zh: '账户', en: 'Account' },
    help: { zh: '术语说明', en: 'Glossary' },
    language: { zh: '切换为 English', en: '切换为中文' },
    logout: { zh: '退出登录', en: 'Sign out' },
    primary: { zh: '主导航', en: 'Primary navigation' },
    mobilePrimary: { zh: '移动端主导航', en: 'Mobile primary navigation' },
    dataStatus: { zh: '数据状态', en: 'Data status' },
    dataLocked: { zh: '公开预览', en: 'Public preview' },
    dataReady: { zh: '数据已同步', en: 'Up to date' },
    dataSyncing: { zh: '同步中', en: 'Syncing' },
    dataWatch: { zh: '数据待核', en: 'Data notice' },
    dataError: { zh: '数据异常', en: 'Data issue' },
    dataPublishing: { zh: '发布切换', en: 'Publishing' },
    dataRetrying: { zh: '同步重试', en: 'Retrying' },
    dataIntegrity: { zh: '完整性待核', en: 'Integrity check' },
    dataStale: { zh: '更新滞后', en: 'Delayed' },
    dataEvidence: { zh: '参考模式', en: 'Reference' },
    dataFallback: { zh: '降级读取', en: 'Fallback' },
    dataLoading: { zh: '读取赛程', en: 'Loading' },
    dataTime: { zh: '数据时间（北京）', en: 'Data time (Beijing)' },
    checkedTime: { zh: '最近检查（北京）', en: 'Last checked (Beijing)' },
    connection: { zh: '更新连接', en: 'Update connection' },
    modelStatus: { zh: '推荐状态', en: 'Recommendation status' },
    reference: { zh: '参考／影子，尚未通过正式门槛', en: 'Reference / shadow; formal gate not passed' },
    modelReady: { zh: '已通过当前发布校验', en: 'Current publication checks passed' },
    unknown: { zh: '尚未取得状态', en: 'Status unavailable' },
    close: { zh: '关闭数据状态', en: 'Close data status' },
    retained: { zh: '正在显示保留快照', en: 'Showing a retained snapshot' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';
  const activeTab = currentTab === 'detail' ? 'fixtures' : currentTab === 'account' ? 'my' : currentTab;
  const toolsActive = currentTab === 'tools' || currentTab === 'generator';
  const moreActive = toolsActive || currentTab === 'predictions';
  const publicationTransition = [
    'generation-sqlite-mismatch',
    'generation-pair-refresh',
    'generation-sqlite-replacement',
    'sqlite-previous-pair',
    'previous-generation',
    'generation-previous',
    'postgres-publication-transition'
  ].includes(dataSync.healthCurrentReadSource || '')
    || Boolean(dataSync.error?.includes('[POSTGRES_PUBLICATION_TRANSITION]'));
  const visibleScheduleRetained = dataSync.currentLoaded && dataSync.currentCount > 0;

  const dataStatus: DataStatus = (() => {
    if (!isAccessVerified) return 'locked';
    if (publicationTransition) return 'syncing';
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

  const latestActivityAt = Math.max(finiteDate(dataSync.lastServerEventAt) || 0, finiteDate(dataSync.lastCheckedAt) || 0);
  const activityAgeSeconds = latestActivityAt > 0 ? Math.max(0, Math.round((clockNow - latestActivityAt) / 1000)) : null;
  const transportLabel = !currentUser ? t('dataLocked') : dataSync.error ? t('dataRetrying') : dataSync.liveUpdates === 'sse'
    ? (language === 'zh' ? '连续更新' : 'Live updates')
    : dataSync.refreshIntervalSeconds ? (language === 'zh' ? `每 ${Math.round(dataSync.refreshIntervalSeconds)} 秒刷新` : `Refresh every ${Math.round(dataSync.refreshIntervalSeconds)}s`) : t('unknown');
  const countLabel = dataSync.currentLoaded ? `${dataSync.currentCount}` : '--';
  const freshnessLabel = activityAgeSeconds === null
    ? '--'
    : activityAgeSeconds < 60
      ? `${activityAgeSeconds}s`
      : `${Math.floor(activityAgeSeconds / 60)}m`;
  const dataStatusReadable = dataStatus !== 'ready' && dataStatus !== 'locked';
  const dataStatusDisplayLabel = dataStatus === 'watch' && dataStatusDetail === t('dataEvidence') ? t('dataEvidence') : dataStatusLabel;
  const formatTime = (value: string | undefined) => {
    const at = finiteDate(value);
    return at === null ? '—' : new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Shanghai' }).format(at);
  };
  const dataStatusTitle = [
    t('dataStatus'),
    dataStatusLabel,
    dataStatusDetail,
    `${language === 'zh' ? '通道' : 'transport'} ${transportLabel}`,
    `${language === 'zh' ? '场次' : 'fixtures'} ${countLabel}`,
    `${language === 'zh' ? '活动' : 'activity'} ${freshnessLabel}`,
  ].filter(Boolean).join(' · ');

  const closeMore = useCallback((restoreFocus = false) => {
    setIsMoreOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => moreTriggerRef.current?.focus());
  }, []);
  const closeStatus = useCallback((restoreFocus = false) => {
    setIsStatusOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => statusTriggerRef.current?.focus());
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

  useEffect(() => {
    if (!isStatusOpen) return;
    const onPointerDown = (event: PointerEvent) => { if (!statusRootRef.current?.contains(event.target as Node)) closeStatus(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeStatus(true); } };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [closeStatus, isStatusOpen]);

  useEffect(() => { setIsMoreOpen(false); setIsStatusOpen(false); }, [currentTab]);

  const openMore = (last = false) => {
    setIsStatusOpen(false); setIsMoreOpen(true);
    window.requestAnimationFrame(() => focusMenuItem(last ? -1 : 0));
  };
  const openStatus = () => {
    setIsMoreOpen(false); setIsStatusOpen(true);
    window.requestAnimationFrame(() => statusPanelRef.current?.focus());
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); focusMenuItem(currentIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusMenuItem(currentIndex - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusMenuItem(0); }
    else if (event.key === 'End') { event.preventDefault(); focusMenuItem(-1); }
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
            aria-current={isActive ? 'page' : undefined} onClick={() => setCurrentTab(key === 'my' ? 'account' : key)}>
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
          <button type="button" className="app-brand" onClick={() => setCurrentTab('best')} aria-label={t('brand')}>
            <span className="app-brand-mark" aria-hidden="true">90</span>
            <span className="app-brand-copy">
              <span className="app-brand-title">{t('brand')}</span>
              <span className="app-brand-subtitle">{t('subtitle')}</span>
            </span>
          </button>

          {renderPrimaryNavigation()}

          <div className="app-topbar-actions">
            <div className="app-status-root" ref={statusRootRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeStatus(); }}>
              <button ref={statusTriggerRef} type="button" className={`app-data-status is-${dataStatus} ${dataStatusReadable ? 'is-readable' : ''}`}
                aria-label={`${t('dataStatus')}：${dataStatusDisplayLabel}`} title={dataStatusTitle}
                aria-expanded={isStatusOpen} aria-controls="app-status-panel" aria-haspopup="dialog"
                onClick={() => isStatusOpen ? closeStatus() : openStatus()}
                onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openStatus(); } }}>
                <span className="app-data-status-dot" aria-hidden="true" />
                <span>{dataStatusDisplayLabel}</span><ChevronDown size={13} aria-hidden="true" />
              </button>
              {isStatusOpen && <div id="app-status-panel" className="app-status-panel" role="dialog" aria-label={t('dataStatus')} tabIndex={-1} ref={statusPanelRef}>
                <div className="app-status-panel-heading"><Radio size={16} /><strong>{t('dataStatus')}</strong><button type="button" aria-label={t('close')} onClick={() => closeStatus(true)}>×</button></div>
                <p className={`app-status-message is-${dataStatus}`}>{dataStatusLabel}{dataStatusDetail ? ` · ${dataStatusDetail}` : ''}</p>
                {dataSync.dataChannel === 'retained' && <p className="app-status-retained">{t('retained')}</p>}
                <dl>
                  <div><dt>{t('dataTime')}</dt><dd>{formatTime(dataSync.sourceUpdatedAt)}</dd></div>
                  <div><dt>{t('checkedTime')}</dt><dd>{formatTime(dataSync.lastCheckedAt)}</dd></div>
                  <div><dt>{t('connection')}</dt><dd>{transportLabel}</dd></div>
                  <div><dt>{language === 'zh' ? '当前比赛' : 'Current fixtures'}</dt><dd>{countLabel}</dd></div>
                  <div><dt>{t('modelStatus')}</dt><dd>{!currentUser ? t('dataLocked') : dataSync.recommendationReliable === false ? t('reference') : dataSync.recommendationReliable === true ? t('modelReady') : t('unknown')}</dd></div>
                </dl>
              </div>}
            </div>

            <div className="app-more" ref={moreRootRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMore(); }}>
              <button ref={moreTriggerRef} type="button" className={`app-more-trigger ${isMoreOpen || moreActive ? 'is-active' : ''}`}
                aria-label={currentUser ? `${t('accountMenu')} · ${t('moreMenu')}` : t('moreMenu')} aria-haspopup="menu" aria-expanded={isMoreOpen} aria-controls="app-more-menu"
                onClick={() => isMoreOpen ? closeMore() : openMore()}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') { event.preventDefault(); openMore(); }
                  else if (event.key === 'ArrowUp') { event.preventDefault(); openMore(true); }
                }}>
                {currentUser ? <UserIcon size={18} /> : <MoreHorizontal size={18} />}
                <span>{currentUser ? t('accountMenu') : t('more')}</span>
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
                  <button ref={(node) => { menuItemRefs.current[3] = node; }} type="button" role="menuitem"
                    className={currentTab === 'predictions' ? 'is-active' : undefined} onClick={() => selectFromMenu(() => setCurrentTab('predictions'))}>
                    <ListChecks size={17} /><span>{t('matchAnalysis')}</span>
                  </button>
                  <button ref={(node) => { menuItemRefs.current[4] = node; }} type="button" role="menuitem" onClick={() => selectFromMenu(() => setCurrentTab('arena'))}><Target size={17}/><span>{t('arena')}</span></button>
                  <button ref={(node) => { menuItemRefs.current[5] = node; }} type="button" role="menuitem" onClick={() => selectFromMenu(() => setCurrentTab('leagues'))}><Shield size={17}/><span>{t('topLeagues')}</span></button>
                  {currentUser && <button ref={(node) => { menuItemRefs.current[6] = node; }} type="button" role="menuitem" className="is-danger"
                    onClick={() => selectFromMenu(logout)}><LogOut size={17} /><span>{t('logout')}</span></button>}
                </div>
              )}
            </div>

            {!currentUser && (
              <button type="button" className="app-account-button" onClick={() => setCurrentTab('auth')}>
                <UserIcon size={16} /><span>{t('login')}</span>
              </button>
            )}
          </div>
        </div>
      </header>
      {logoutError && <p role="alert" className="account-inline-error">{logoutError}</p>}
      {renderPrimaryNavigation(true)}
    </>
  );
};
