import { useState } from 'react';
import { AppProvider } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ContactDock } from './components/ContactDock';
import { GlossaryModal } from './components/GlossaryModal';

// 导入页面
import { PredictionsList } from './pages/PredictionsList';
import { BestTips } from './pages/BestTips';
import { BetSlipGenerator } from './pages/BetSlipGenerator';
import { HitAndWin } from './pages/HitAndWin';
import { Auth } from './pages/Auth';
import { MatchDetail } from './pages/MatchDetail';

function AppContent() {
  const [currentTab, setCurrentTab] = useState<string>('predictions');
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [isGlossaryOpen, setIsGlossaryOpen] = useState<boolean>(false);

  // 渲染对应的标签页内容
  const renderContent = () => {
    switch (currentTab) {
      case 'predictions':
        return (
          <PredictionsList 
            onSelectMatch={(matchId) => {
              setActiveMatchId(matchId);
              setCurrentTab('detail');
            }}
          />
        );
      case 'best':
        return (
          <BestTips 
            onSelectMatch={(matchId) => {
              setActiveMatchId(matchId);
              setCurrentTab('detail');
            }}
          />
        );
      case 'generator':
        return <BetSlipGenerator />;
      case 'hitwin':
        return (
          <HitAndWin 
            onGoToAuth={() => setCurrentTab('auth')}
          />
        );
      case 'auth':
        return (
          <Auth 
            onSuccess={() => setCurrentTab('predictions')}
          />
        );
      case 'detail':
        if (activeMatchId) {
          return (
            <MatchDetail 
              matchId={activeMatchId}
              onBack={() => {
                // 如果是从精选页来的就返回精选，否则返回预测列表
                setCurrentTab('predictions');
                setActiveMatchId(null);
              }}
            />
          );
        }
        return <PredictionsList onSelectMatch={(id) => { setActiveMatchId(id); setCurrentTab('detail'); }} />;
      default:
        return <PredictionsList onSelectMatch={(id) => { setActiveMatchId(id); setCurrentTab('detail'); }} />;
    }
  };

  return (
    <div className="app-frame">
      {/* 顶部导航 */}
      <Navbar 
        currentTab={currentTab} 
        setCurrentTab={(tab) => {
          setCurrentTab(tab);
          setActiveMatchId(null); // 切换 tab 时清除选中比赛
        }} 
        openGlossary={() => setIsGlossaryOpen(true)}
      />

      {/* 主体渲染区 */}
      <main className="container page-main">
        {renderContent()}
      </main>

      {/* 底部声明 */}
      <Footer />

      <ContactDock />

      {/* 全局弹窗 */}
      <GlossaryModal 
        isOpen={isGlossaryOpen} 
        onClose={() => setIsGlossaryOpen(false)}
      />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
