import { Component, lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { GlossaryModal } from './components/GlossaryModal';
import { useApp } from './context/AppContextCore';

const PredictionsList = lazy(() => import('./pages/PredictionsList').then((module) => ({ default: module.PredictionsList })));
const BestTips = lazy(() => import('./pages/BestTips').then((module) => ({ default: module.BestTips })));
const BetSlipGenerator = lazy(() => import('./pages/BetSlipGenerator').then((module) => ({ default: module.BetSlipGenerator })));
const HitAndWin = lazy(() => import('./pages/HitAndWin').then((module) => ({ default: module.HitAndWin })));
const Auth = lazy(() => import('./pages/Auth').then((module) => ({ default: module.Auth })));
const AccessCodeAdmin = lazy(() => import('./pages/AccessCodeAdmin').then((module) => ({ default: module.AccessCodeAdmin })));
const MatchDetail = lazy(() => import('./pages/MatchDetail').then((module) => ({ default: module.MatchDetail })));
const BigFiveLeagues = lazy(() => import('./pages/BigFiveLeagues').then((module) => ({ default: module.BigFiveLeagues })));
const AIArena = lazy(() => import('./pages/AIArena').then((module) => ({ default: module.AIArena })));

const ASSET_RELOAD_STORAGE_KEY = 'football.assetReloadAt';

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
};

const isAssetLoadError = (error: unknown) => {
  const message = getErrorMessage(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .* failed/i.test(message);
};

const isLikelyStaleMatchDetailRuntimeError = (error: unknown) => {
  const message = getErrorMessage(error);
  if (!/Cannot read (?:properties|property) of (?:undefined|null)/i.test(message)) return false;
  return /\b(over25|under25|bttsYes|bttsNo|goalLines|bothTeamsToScore|probabilities)\b|reading ['"](yes|no|zh|en|exactTop3|projectedScore|tipLabel|summary)['"]/i.test(message);
};

const isRecoverableRouteError = (error: unknown) => (
  isAssetLoadError(error) || isLikelyStaleMatchDetailRuntimeError(error)
);

const reloadForFreshAssets = () => {
  if (typeof window === 'undefined') return false;

  const now = Date.now();
  const lastReloadAt = Number(window.sessionStorage.getItem(ASSET_RELOAD_STORAGE_KEY) || 0);
  if (Number.isFinite(lastReloadAt) && now - lastReloadAt < 15_000) return false;

  window.sessionStorage.setItem(ASSET_RELOAD_STORAGE_KEY, String(now));
  const freshUrl = new URL(window.location.href);
  freshUrl.searchParams.set('__assetReload', String(now));
  window.location.replace(freshUrl.toString());
  return true;
};

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForFreshAssets()) event.preventDefault();
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isRecoverableRouteError(event.reason) && reloadForFreshAssets()) {
      event.preventDefault();
    }
  });
}

type RouteRecoveryState = 'idle' | 'reloading' | 'blocked';

class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; recoveryState: RouteRecoveryState }
> {
  state: { error: Error | null; recoveryState: RouteRecoveryState } = {
    error: null,
    recoveryState: 'idle'
  };

  handleRetry = () => {
    window.sessionStorage.removeItem(ASSET_RELOAD_STORAGE_KEY);
    window.location.reload();
  };

  handleBackToPredictions = () => {
    window.location.assign(`${import.meta.env.BASE_URL || '/'}predictions`);
  };

  static getDerivedStateFromError(error: Error) {
    return { error, recoveryState: 'idle' as RouteRecoveryState };
  }

  componentDidCatch(error: Error) {
    if (isRecoverableRouteError(error)) {
      const reloadStarted = reloadForFreshAssets();
      this.setState({ recoveryState: reloadStarted ? 'reloading' : 'blocked' });
      if (reloadStarted) return;
    }
    console.error(error);
  }

  render() {
    if (this.state.error) {
      if (isRecoverableRouteError(this.state.error) && this.state.recoveryState !== 'blocked') {
        return (
          <div className="route-loading" role="status">
            <span className="route-loading-dot" />
            <span>正在更新页面资源...</span>
          </div>
        );
      }

      const isChinese = typeof document !== 'undefined' && document.documentElement.lang.startsWith('zh');
      return (
        <div className="route-error" role="alert">
          <strong>{isChinese ? '页面加载失败' : 'Page failed to load'}</strong>
          <span>{this.state.error.message || (isChinese ? '请返回列表后重试。' : 'Return to the list or try again.')}</span>
          <div className="route-error-actions">
            <button type="button" className="btn btn-primary" onClick={this.handleRetry}>
              {isChinese ? '重试' : 'Try again'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={this.handleBackToPredictions}>
              {isChinese ? '返回赛事列表' : 'Back to predictions'}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const tabPaths: Record<string, string> = {
  predictions: '/predictions',
  fixtures: '/fixtures',
  arena: '/ai-arena',
  review: '/review',
  leagues: '/leagues',
  tools: '/tools',
  best: '/best',
  generator: '/betslip',
  auth: '/auth'
};

const decodeRouteParam = (value: string | undefined) => {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const getTabFromPath = (pathname: string) => {
  if (pathname === '/') return 'predictions';
  if (pathname.startsWith('/fixtures') || pathname.startsWith('/matches')) return 'fixtures';
  if (pathname.startsWith('/ai-arena')) return 'arena';
  if (pathname.startsWith('/review') || pathname.startsWith('/hitwin')) return 'review';
  if (pathname.startsWith('/tools')) return 'tools';
  if (pathname.startsWith('/best')) return 'best';
  if (pathname.startsWith('/leagues') || pathname.startsWith('/worldcup')) return 'leagues';
  if (pathname.startsWith('/betslip') || pathname.startsWith('/generator')) return 'generator';
  if (pathname.startsWith('/auth')) return 'auth';
  if (pathname.startsWith('/match/')) return 'detail';
  return 'predictions';
};

function LoadingPanel() {
  return (
    <div className="route-loading" role="status">
      <span className="route-loading-dot" />
      <span>正在加载页面...</span>
    </div>
  );
}

function MatchDetailRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const { matchId } = useParams();
  const resolvedMatchId = decodeRouteParam(matchId);
  const routeState = location.state as { openedFromList?: boolean; fromPath?: string } | null;

  if (!resolvedMatchId) {
    return <Navigate to="/predictions" replace />;
  }

  return (
    <MatchDetail
      matchId={resolvedMatchId}
      initialTab={routeState?.fromPath === '/review' ? 'history' : 'overview'}
      onBack={() => {
        if (routeState?.openedFromList) {
          navigate(-1);
          return;
        }
        navigate(routeState?.fromPath || '/predictions', { replace: true });
      }}
    />
  );
}

function ToolsHub({ openGlossary }: { openGlossary: () => void }) {
  const { language } = useApp();
  const navigate = useNavigate();
  const items = [
    {
      key: 'formal',
      title: language === 'zh' ? '赛前推荐' : 'Pre-match picks',
      description: language === 'zh'
        ? '查看官方在售、正期望且通过硬风险过滤的今日精选；正式命中统计保持独立。'
        : 'Today’s selected on-sale positive-EV picks; audited formal statistics remain separate.',
      action: language === 'zh' ? '打开赛前推荐' : 'Open pre-match picks',
      onClick: () => navigate('/best')
    },
    {
      key: 'combo',
      title: language === 'zh' ? '正式组合工具' : 'Formal combo tool',
      description: language === 'zh'
        ? '只消费已开售的正式推荐；正式池不足时不会生成组合。'
        : 'Consumes only on-sale formal picks and stays paused when the formal pool is insufficient.',
      action: language === 'zh' ? '打开组合工具' : 'Open combo tool',
      onClick: () => navigate('/betslip')
    },
    {
      key: 'glossary',
      title: language === 'zh' ? '玩法与口径术语' : 'Markets and definitions',
      description: language === 'zh'
        ? '查看 HAD、HHAD、让球符号、正式推荐与分析参考等定义。'
        : 'Definitions for HAD, HHAD, handicap signs, formal picks and analysis references.',
      action: language === 'zh' ? '打开术语表' : 'Open glossary',
      onClick: openGlossary
    }
  ];

  return (
    <section className="tools-hub" aria-labelledby="tools-hub-title">
      <header className="tools-hub-header">
        <span>{language === 'zh' ? '低频功能' : 'Utilities'}</span>
        <h1 id="tools-hub-title">
          {language === 'zh' ? '更多工具' : 'More Tools'}
        </h1>
        <p>
          {language === 'zh'
            ? '分析主流程保留在顶部导航；低频工具集中在这里。'
            : 'The primary analysis flow stays in the top navigation; lower-frequency tools live here.'}
        </p>
      </header>
      <div className="tools-hub-grid">
        {items.map((item) => (
          <article key={item.key} className="card tools-hub-card">
            <h2>{item.title}</h2>
            <p>{item.description}</p>
            <button type="button" className="btn btn-secondary" onClick={item.onClick}>
              {item.action}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function RequireAccess({ children }: { children: ReactNode }) {
  const { isAccessVerified } = useApp();
  const location = useLocation();

  if (!isAccessVerified) {
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

function RoutedContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const { language } = useApp();
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);

  const routeLabel = (() => {
    if (location.pathname.startsWith('/match/')) return language === 'zh' ? '比赛详情' : 'Match Detail';
    if (location.pathname.startsWith('/ai-arena')) return language === 'zh' ? '五大联赛策略模拟场' : 'Big Five Strategy Lab';
    const routeLabels: Record<string, { zh: string; en: string }> = {
      '/predictions': { zh: '赛前分析', en: 'Pre-match Analysis' },
      '/fixtures': { zh: '赛程与赔率', en: 'Fixtures and Odds' },
      '/leagues': { zh: '五大联赛', en: 'Top Leagues' },
      '/review': { zh: '赛后复盘', en: 'Review' },
      '/best': { zh: '赛前推荐', en: 'Pre-match Picks' },
      '/betslip': { zh: '组合工具', en: 'Bet Slip' },
      '/tools': { zh: '更多工具', en: 'Tools' },
      '/auth': { zh: '访问校验', en: 'Access' },
      '/codes': { zh: '访问码管理', en: 'Access Codes' }
    };
    return routeLabels[location.pathname]?.[language] || (language === 'zh' ? '足球分析' : 'Football Analysis');
  })();

  useEffect(() => {
    document.title = `${routeLabel} · 90分钟足球分析`;
  }, [routeLabel]);

  useLayoutEffect(() => {
    if (!location.pathname.startsWith('/match/')) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  const selectMatch = (matchId: string) => {
    try {
      window.sessionStorage.setItem('football.detailNavigationStartedAt', String(Date.now()));
      if (location.pathname === '/predictions' || location.pathname === '/fixtures') {
        window.sessionStorage.setItem(
          `football.listReturnScroll.${location.pathname}`,
          JSON.stringify({ savedAt: Date.now(), scrollY: window.scrollY })
        );
      }
    } catch {
      // Navigation must remain available when storage is disabled.
    }
    navigate(`/match/${encodeURIComponent(matchId)}`, {
      state: {
        openedFromList: true,
        fromPath: `${location.pathname}${location.search}`
      }
    });
  };
  const handleAuthSuccess = () => {
    const state = location.state as { from?: { pathname?: string; search?: string } } | null;
    const from = state?.from;
    navigate(from?.pathname ? `${from.pathname}${from.search || ''}` : '/predictions', { replace: true });
  };

  return (
    <div className="app-frame app-shell-v2">
      <a className="skip-link" href="#main-content">
        {language === 'zh' ? '跳到主要内容' : 'Skip to main content'}
      </a>
      <div className="route-announcer" role="status" aria-live="polite" aria-atomic="true">
        {routeLabel}
      </div>
      <Navbar
        currentTab={getTabFromPath(location.pathname)}
        setCurrentTab={(tab) => navigate(tabPaths[tab] || '/predictions')}
        openGlossary={() => setIsGlossaryOpen(true)}
      />

      <main id="main-content" className="container page-main" tabIndex={-1}>
        <RouteErrorBoundary key={location.pathname}>
          <Suspense fallback={<LoadingPanel />}>
            <Routes>
              <Route path="/" element={<Navigate to="/predictions" replace />} />
              <Route
                path="/predictions"
                element={(
                  <RequireAccess>
                    <PredictionsList viewMode="analysis" onSelectMatch={selectMatch} />
                  </RequireAccess>
                )}
              />
              <Route
                path="/best"
                element={(
                  <RequireAccess>
                    <BestTips onSelectMatch={selectMatch} />
                  </RequireAccess>
                )}
              />
              <Route
                path="/fixtures"
                element={(
                  <RequireAccess>
                    <PredictionsList viewMode="fixtures" onSelectMatch={selectMatch} />
                  </RequireAccess>
                )}
              />
              <Route path="/matches" element={<Navigate to="/fixtures" replace />} />
              <Route
                path="/leagues"
                element={(
                  <RequireAccess>
                    <BigFiveLeagues onSelectMatch={selectMatch} />
                  </RequireAccess>
                )}
              />
              <Route path="/worldcup" element={<Navigate to="/leagues" replace />} />
              <Route
                path="/betslip"
                element={(
                  <RequireAccess>
                    <BetSlipGenerator onOpenObservations={() => navigate('/best')} />
                  </RequireAccess>
                )}
              />
              <Route path="/generator" element={<Navigate to="/betslip" replace />} />
              <Route
                path="/review"
                element={(
                  <RequireAccess>
                    <HitAndWin />
                  </RequireAccess>
                )}
              />
              <Route path="/hitwin" element={<Navigate to="/review" replace />} />
              <Route
                path="/tools"
                element={(
                  <RequireAccess>
                    <ToolsHub openGlossary={() => setIsGlossaryOpen(true)} />
                  </RequireAccess>
                )}
              />
              <Route
                path="/auth"
                element={<Auth onSuccess={handleAuthSuccess} />}
              />
              <Route path="/codes" element={<AccessCodeAdmin />} />
              <Route
                path="/match/:matchId"
                element={(
                  <RequireAccess>
                    <MatchDetailRoute />
                  </RequireAccess>
                )}
              />
              <Route
                path="/ai-arena"
                element={(
                  <RequireAccess>
                    <AIArena />
                  </RequireAccess>
                )}
              />
              <Route
                path="/ai-arena/:matchId"
                element={(
                  <RequireAccess>
                    <AIArena />
                  </RequireAccess>
                )}
              />
              <Route path="*" element={<Navigate to="/predictions" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </main>

      <Footer />
      <GlossaryModal
        isOpen={isGlossaryOpen}
        onClose={() => setIsGlossaryOpen(false)}
      />
    </div>
  );
}

export default function App() {
  const baseName = import.meta.env.BASE_URL && import.meta.env.BASE_URL !== '/'
    ? import.meta.env.BASE_URL.replace(/\/$/, '')
    : undefined;

  return (
    <AppProvider>
      <BrowserRouter basename={baseName}>
        <RoutedContent />
      </BrowserRouter>
    </AppProvider>
  );
}
