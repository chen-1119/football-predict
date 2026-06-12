import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
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
import { ContactDock } from './components/ContactDock';
import { GlossaryModal } from './components/GlossaryModal';
import { useApp } from './context/AppContextCore';

const PredictionsList = lazy(() => import('./pages/PredictionsList').then((module) => ({ default: module.PredictionsList })));
const BestTips = lazy(() => import('./pages/BestTips').then((module) => ({ default: module.BestTips })));
const BetSlipGenerator = lazy(() => import('./pages/BetSlipGenerator').then((module) => ({ default: module.BetSlipGenerator })));
const HitAndWin = lazy(() => import('./pages/HitAndWin').then((module) => ({ default: module.HitAndWin })));
const Auth = lazy(() => import('./pages/Auth').then((module) => ({ default: module.Auth })));
const AccessCodeAdmin = lazy(() => import('./pages/AccessCodeAdmin').then((module) => ({ default: module.AccessCodeAdmin })));
const MatchDetail = lazy(() => import('./pages/MatchDetail').then((module) => ({ default: module.MatchDetail })));
const WorldCup = lazy(() => import('./pages/WorldCup').then((module) => ({ default: module.WorldCup })));

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

const reloadForFreshAssets = () => {
  if (typeof window === 'undefined') return false;

  const now = Date.now();
  const lastReloadAt = Number(window.sessionStorage.getItem(ASSET_RELOAD_STORAGE_KEY) || 0);
  if (Number.isFinite(lastReloadAt) && now - lastReloadAt < 15_000) return false;

  window.sessionStorage.setItem(ASSET_RELOAD_STORAGE_KEY, String(now));
  window.location.reload();
  return true;
};

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    reloadForFreshAssets();
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isAssetLoadError(event.reason)) {
      event.preventDefault();
      reloadForFreshAssets();
    }
  });
}

class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isAssetLoadError(error) && reloadForFreshAssets()) return;
    console.error(error);
  }

  render() {
    if (this.state.error) {
      if (isAssetLoadError(this.state.error)) {
        return (
          <div className="route-loading" role="status">
            <span className="route-loading-dot" />
            <span>正在更新页面资源...</span>
          </div>
        );
      }

      return (
        <div className="route-error" role="alert">
          <strong>页面加载失败</strong>
          <span>{this.state.error.message || '请返回列表后重试。'}</span>
        </div>
      );
    }

    return this.props.children;
  }
}

const tabPaths: Record<string, string> = {
  best: '/best',
  predictions: '/predictions',
  worldcup: '/worldcup',
  generator: '/betslip',
  hitwin: '/hitwin',
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
  if (pathname.startsWith('/best')) return 'best';
  if (pathname.startsWith('/worldcup')) return 'worldcup';
  if (pathname.startsWith('/betslip') || pathname.startsWith('/generator')) return 'generator';
  if (pathname.startsWith('/hitwin')) return 'hitwin';
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
  const { matchId } = useParams();
  const resolvedMatchId = decodeRouteParam(matchId);

  if (!resolvedMatchId) {
    return <Navigate to="/predictions" replace />;
  }

  return (
    <MatchDetail
      matchId={resolvedMatchId}
      onBack={() => navigate('/predictions')}
    />
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
  const [isGlossaryOpen, setIsGlossaryOpen] = useState(false);

  const openWorldCup = () => navigate('/worldcup');
  const selectMatch = (matchId: string) => navigate(`/match/${encodeURIComponent(matchId)}`);
  const handleAuthSuccess = () => {
    const state = location.state as { from?: { pathname?: string; search?: string } } | null;
    const from = state?.from;
    navigate(from?.pathname ? `${from.pathname}${from.search || ''}` : '/predictions', { replace: true });
  };

  return (
    <div className="app-frame">
      <Navbar
        currentTab={getTabFromPath(location.pathname)}
        setCurrentTab={(tab) => navigate(tabPaths[tab] || '/predictions')}
        openGlossary={() => setIsGlossaryOpen(true)}
      />

      <main className="container page-main">
        <RouteErrorBoundary>
          <Suspense fallback={<LoadingPanel />}>
            <Routes>
              <Route path="/" element={<Navigate to="/predictions" replace />} />
              <Route
                path="/predictions"
                element={(
                  <RequireAccess>
                    <PredictionsList onOpenWorldCup={openWorldCup} onSelectMatch={selectMatch} />
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
                path="/worldcup"
                element={(
                  <RequireAccess>
                    <WorldCup onSelectMatch={selectMatch} />
                  </RequireAccess>
                )}
              />
              <Route
                path="/betslip"
                element={(
                  <RequireAccess>
                    <BetSlipGenerator />
                  </RequireAccess>
                )}
              />
              <Route path="/generator" element={<Navigate to="/betslip" replace />} />
              <Route
                path="/hitwin"
                element={<HitAndWin onGoToAuth={() => navigate('/auth')} />}
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
              <Route path="*" element={<Navigate to="/predictions" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </main>

      <Footer />
      <ContactDock />
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
