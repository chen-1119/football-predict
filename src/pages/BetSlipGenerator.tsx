import React, { useState } from 'react';
import { useApp } from '../context/AppContextCore';
import { generateBetSlip } from '../services/generator';
import type { BetSlipResult } from '../services/generator';
import { Sparkles, RefreshCw, Copy, Check, Lock, ShieldAlert, Award } from 'lucide-react';
import { getMarketLabel, getPredictionTipDisplay } from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';

type TimeWindow = '1' | '2' | '3';

interface SlipMeta {
  id: string;
  date: string;
}

const isTimeWindow = (value: string): value is TimeWindow => {
  return value === '1' || value === '2' || value === '3';
};

const createSlipMeta = (result: BetSlipResult): SlipMeta => {
  const seed = result.selections
    .map((selection) => `${selection.match.id}:${selection.prediction.marketType}:${selection.prediction.tipCode}`)
    .join('|');
  let hash = 0;

  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  return {
    id: `SLIP_${100000 + (hash % 900000)}`,
    date: new Date().toLocaleDateString()
  };
};

export const BetSlipGenerator: React.FC = () => {
  const { language, isPremium, togglePremium, dailySlipCount, incrementSlipCount, matches } = useApp();

  // 表单状态
  const [targetOdds, setTargetOdds] = useState<number>(2.00);
  const [matchCount, setMatchCount] = useState<'auto' | 2 | 5 | 10 | 15>('auto');
  const [selectedMarkets, setSelectedMarkets] = useState<string[]>(['1X2', 'GOALS', 'GG_NG', 'BEST']);
  const [minOdds, setMinOdds] = useState<number>(1.20);
  const [maxOdds, setMaxOdds] = useState<number>(3.00);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('3');
  const [minTrust, setMinTrust] = useState<number>(60);
  const [onlyImportant, setOnlyImportant] = useState<boolean>(true);
  
  // 生成结果
  const [generationResult, setGenerationResult] = useState<BetSlipResult | null>(null);
  const [slipMeta, setSlipMeta] = useState<SlipMeta | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const translations = {
    title: { zh: 'AI 投注单串关生成器', en: 'AI Bet Slip Generator' },
    subtitle: { 
      zh: '依托深度学习预测引擎，智能扫描未来 72 小时内的海量预测，为您一键组合最佳串关。', 
      en: 'Generate optimized accumulators based on mathematical confidence levels and target odds instantly.' 
    },
    freeLimitNotice: {
      zh: '当前为免费模式：每日限量生成 1 张，总SP上限为 2.00，可信度上限 65%。',
      en: 'Free Mode active: Max 1 slip/day, target odds capped at 2.00, trust capped at 65%.'
    },
    premiumUnlockNotice: {
      zh: '升级至 VIP：解锁 150x 超高总SP串关、全选比赛场次、最高 100% 可信度筛选及稳胆组合！',
      en: 'Upgrade to PRO: Unlock up to 150x cumulative odds, customize counts, and access elite algorithms.'
    },
    targetOddsLabel: { zh: '目标总SP', en: 'Target Combined Odds' },
    matchCountLabel: { zh: '串关比赛数量', en: 'Number of Selections' },
    auto: { zh: '智能推荐 (Auto)', en: 'Auto' },
    marketsLabel: { zh: '包含预测市场', en: 'Markets to Include' },
    minOddsLabel: { zh: '单场最低SP', en: 'Min Single Odds' },
    maxOddsLabel: { zh: '单场最高SP', en: 'Max Single Odds' },
    timeWindowLabel: { zh: '比赛时间窗口', en: 'Time Window' },
    minTrustLabel: { zh: '最低可信度要求', en: 'Min Confidence Threshold' },
    onlyImportantLabel: { zh: '仅限顶级联赛', en: 'Only Elite Leagues' },
    generateBtn: { zh: 'AI 一键生成投注单', en: 'Generate Accumulator' },
    resetBtn: { zh: '重置配置', en: 'Reset Filters' },
    copyBtn: { zh: '复制投注单', en: 'Copy Bet Slip' },
    copiedText: { zh: '已复制！', en: 'Copied!' },
    slipTitle: { zh: 'AI 生成投注票据 (Accumulator Ticket)', en: 'AI Smart Ticket' },
    slipSummary: { zh: '投注汇总', en: 'Summary' },
    totalOdds: { zh: '总SP', en: 'Total Odds' },
    avgTrust: { zh: '平均可信度', en: 'Avg Confidence' },
    activeSlip: { zh: '今日已用免费生成额度：', en: 'Daily Free Slip Count:' },
    outOfQuota: { zh: '您已达到今日免费生成上限 (1张)。模拟升级 PRO 即可无限制生成！', en: 'You reached the free limit (1/day). Simulate Pro to unlock unlimited!' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  const handleMarketToggle = (market: string) => {
    if (selectedMarkets.includes(market)) {
      if (selectedMarkets.length > 1) {
        setSelectedMarkets(selectedMarkets.filter(m => m !== market));
      }
    } else {
      setSelectedMarkets([...selectedMarkets, market]);
    }
  };

  const handleGenerate = () => {
    setErrorMsg(null);

    // 检查额度
    if (!isPremium && dailySlipCount >= 1) {
      setErrorMsg(t('outOfQuota'));
      return;
    }

    const result = generateBetSlip({
      targetOdds,
      matchCount,
      marketTypes: selectedMarkets,
      minOdds,
      maxOdds,
      timeWindow,
      minTrust,
      onlyImportantLeagues: onlyImportant,
      onlyOddsDropping: false,
      isPremiumUser: isPremium
    }, matches);

    if (result.isSuccess) {
      // 扣减额度
      incrementSlipCount();
      setSlipMeta(createSlipMeta(result));
    } else {
      setSlipMeta(null);
    }
    setGenerationResult(result);
  };

  const handleReset = () => {
    setTargetOdds(2.00);
    setMatchCount('auto');
    setSelectedMarkets(['1X2', 'GOALS', 'GG_NG', 'BEST']);
    setMinOdds(1.20);
    setMaxOdds(3.00);
    setTimeWindow('3');
    setMinTrust(60);
    setOnlyImportant(true);
    setGenerationResult(null);
    setSlipMeta(null);
    setErrorMsg(null);
  };

  const handleCopySlip = () => {
    if (!generationResult) return;
    const text = generationResult.selections.map(s => {
      const homeTeam = getTeamById(s.match.homeTeamId);
      const awayTeam = getTeamById(s.match.awayTeamId);
      return `${homeTeam.shortName[language]} vs ${awayTeam.shortName[language]} | ${getMarketLabel(s.prediction.marketType, language)}: ${getPredictionTipDisplay(s.prediction, language)} @${s.prediction.odds}`;
    }).join('\n') + `\n总SP: @${generationResult.totalOdds}`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 头部介绍 */}
      <div style={{ textAlign: 'center', maxWidth: '700px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h2>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {t('subtitle')}
        </p>
      </div>

      {/* 免费/付费提示 */}
      <div className="card premium-card" style={{ 
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem',
        borderColor: isPremium ? 'hsl(var(--primary) / 0.3)' : 'hsl(var(--premium) / 0.3)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', maxWidth: '750px' }}>
          <div style={{ 
            backgroundColor: isPremium ? 'hsl(var(--primary) / 0.15)' : 'hsl(var(--premium) / 0.15)', 
            color: isPremium ? 'hsl(var(--primary))' : 'hsl(var(--premium))', 
            padding: '0.5rem', borderRadius: '10px' 
          }}>
            <Award size={20} />
          </div>
          <div>
            <p style={{ fontSize: '0.85rem', color: 'hsl(var(--text-primary))', fontWeight: '700' }}>
              {isPremium ? (language === 'zh' ? '您当前是 VIP 会员：解锁无限制高总SP串关！' : 'PRO Mode Active: Unlimited slips and high odds unlocked!') : t('freeLimitNotice')}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'hsl(var(--text-secondary))', marginTop: '0.15rem' }}>
              {!isPremium ? t('premiumUnlockNotice') : (language === 'zh' ? '您可以设置最高达 150 总SP，可信度阈值高至 100%' : 'You can configure up to 150 odds and 100% confidence.')}
            </p>
          </div>
        </div>
        {!isPremium && (
          <button onClick={togglePremium} className="btn btn-premium" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
            {language === 'zh' ? '升级 PRO' : 'Simulate Pro'}
          </button>
        )}
      </div>

      {/* 双栏布局 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '2rem', alignItems: 'start' }}>
        
        {/* 左栏：参数配置表单 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* 目标总SP */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label className="form-label">{t('targetOddsLabel')}</label>
              <span style={{ color: 'hsl(var(--primary))', fontWeight: '800' }}>@{targetOdds.toFixed(2)}</span>
            </div>
            <input 
              type="range" 
              min="1.50" 
              max={isPremium ? "150.00" : "2.00"} 
              step="0.05"
              value={targetOdds} 
              onChange={(e) => setTargetOdds(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'hsl(var(--primary))' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'hsl(var(--text-muted))', marginTop: '0.2rem' }}>
              <span>@1.50</span>
              {!isPremium && <span>{language === 'zh' ? '免费上限: @2.00' : 'Free Limit: @2.00'}</span>}
              <span>{isPremium ? '@150.00' : '@2.00'}</span>
            </div>
          </div>

          {/* 比赛数量 */}
          <div className="form-group">
            <label className="form-label">{t('matchCountLabel')}</label>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              {(['auto', 2, 5, 10, 15] as const).map((cnt) => {
                const isSelected = matchCount === cnt;
                // 免费版限制除了 auto/2 之外的其他数量
                const isCntLocked = !isPremium && cnt !== 'auto' && cnt !== 2;
                return (
                  <button
                    key={cnt}
                    disabled={isCntLocked}
                    onClick={() => setMatchCount(cnt)}
                    className="btn btn-secondary"
                    style={{
                      padding: '0.35rem 0.65rem',
                      fontSize: '0.8rem',
                      borderRadius: '8px',
                      backgroundColor: isSelected ? 'hsl(var(--accent) / 0.15)' : 'transparent',
                      borderColor: isSelected ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                      color: isCntLocked ? 'hsl(var(--text-muted))' : (isSelected ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))'),
                      cursor: isCntLocked ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: '0.25rem'
                    }}
                  >
                    <span>{cnt === 'auto' ? t('auto') : `${cnt}场`}</span>
                    {isCntLocked && <Lock size={10} style={{ color: 'hsl(var(--premium))' }} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 包含市场 */}
          <div className="form-group">
            <label className="form-label">{t('marketsLabel')}</label>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              {[
                { id: '1X2', label: getMarketLabel('1X2', language) },
                { id: 'GOALS', label: getMarketLabel('GOALS', language) },
                { id: 'GG_NG', label: getMarketLabel('GG_NG', language) },
                { id: 'BEST', label: getMarketLabel('BEST', language) }
              ].map(m => {
                const isSelected = selectedMarkets.includes(m.id);
                // 免费限制：不能选 BEST 稳胆
                const isMarketLocked = !isPremium && m.id === 'BEST';

                return (
                  <button
                    key={m.id}
                    disabled={isMarketLocked}
                    onClick={() => handleMarketToggle(m.id)}
                    className="btn btn-secondary"
                    style={{
                      padding: '0.35rem 0.65rem',
                      fontSize: '0.8rem',
                      borderRadius: '8px',
                      backgroundColor: isSelected ? 'hsl(var(--accent) / 0.15)' : 'transparent',
                      borderColor: isSelected ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                      color: isMarketLocked ? 'hsl(var(--text-muted))' : (isSelected ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))'),
                      cursor: isMarketLocked ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: '0.25rem'
                    }}
                  >
                    <span>{m.label}</span>
                    {isMarketLocked && <Lock size={10} style={{ color: 'hsl(var(--premium))' }} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 可信度阈值 */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label className="form-label">{t('minTrustLabel')}</label>
              <span style={{ color: 'hsl(var(--primary))', fontWeight: '800' }}>{minTrust}%</span>
            </div>
            <input 
              type="range" 
              min="50" 
              max={isPremium ? "95" : "65"} 
              step="5"
              value={minTrust} 
              onChange={(e) => setMinTrust(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: 'hsl(var(--primary))' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'hsl(var(--text-muted))', marginTop: '0.2rem' }}>
              <span>50%</span>
              {!isPremium && <span>{language === 'zh' ? '免费上限: 65%' : 'Free Limit: 65%'}</span>}
              <span>{isPremium ? '95%' : '65%'}</span>
            </div>
          </div>

          {/* SP 过滤与时间窗口 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label">{t('minOddsLabel')}</label>
              <input 
                type="number" 
                min="1.10" 
                max="3.00" 
                step="0.05"
                className="form-input"
                value={minOdds}
                onChange={(e) => setMinOdds(parseFloat(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{t('maxOddsLabel')}</label>
              <input 
                type="number" 
                min="1.50" 
                max="10.00" 
                step="0.1"
                className="form-input"
                value={maxOdds}
                onChange={(e) => setMaxOdds(parseFloat(e.target.value))}
              />
            </div>
          </div>

          {/* 时间窗口 */}
          <div className="form-group">
            <label className="form-label">{t('timeWindowLabel')}</label>
            <select
              value={timeWindow} 
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                if (isTimeWindow(e.target.value)) {
                  setTimeWindow(e.target.value);
                }
              }}
              className="form-input"
              style={{ appearance: 'none', backgroundPosition: 'right 1rem center', backgroundRepeat: 'no-repeat' }}
            >
              <option value="1">{language === 'zh' ? '未来 24 小时 (今天)' : 'Next 24 Hours'}</option>
              <option value="2">{language === 'zh' ? '未来 48 小时 (明日前)' : 'Next 48 Hours'}</option>
              <option value="3">{language === 'zh' ? '未来 72 小时 (3天内)' : 'Next 72 Hours'}</option>
            </select>
          </div>

          {/* 顶级联赛开关 */}
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input 
              type="checkbox" 
              id="only_imp" 
              checked={onlyImportant} 
              onChange={(e) => setOnlyImportant(e.target.checked)}
              style={{ width: '16px', height: '16px', accentColor: 'hsl(var(--primary))' }}
            />
            <label htmlFor="only_imp" className="form-label" style={{ marginBottom: '0', cursor: 'pointer' }}>
              {t('onlyImportantLabel')}
            </label>
          </div>

          {/* 模拟生成按钮 */}
          <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <button onClick={handleGenerate} className="btn btn-primary" style={{ width: '100%', height: '48px' }}>
              <RefreshCw size={16} />
              <span>{t('generateBtn')}</span>
            </button>
            <button onClick={handleReset} className="btn btn-secondary" style={{ width: '100%' }}>
              {t('resetBtn')}
            </button>
          </div>

          {/* 额度提示 */}
          <div style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', textAlign: 'center', marginTop: '0.25rem' }}>
            {t('activeSlip')} <span style={{ color: isPremium ? 'hsl(var(--primary))' : 'hsl(var(--premium))', fontWeight: 'bold' }}>
              {isPremium ? 'Unlimited (PRO)' : `${dailySlipCount}/1`}
            </span>
          </div>

        </div>

        {/* 右栏：生成结果展现 */}
        <div>
          
          {errorMsg && (
            <div className="card" style={{ border: '1px solid hsl(var(--danger) / 0.3)', backgroundColor: 'hsl(var(--danger) / 0.1)', color: 'hsl(var(--text-primary))', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem', borderRadius: '12px', marginBottom: '1rem' }}>
              <ShieldAlert size={20} style={{ color: 'hsl(var(--danger))' }} />
              <span style={{ fontSize: '0.85rem' }}>{errorMsg}</span>
            </div>
          )}

          {generationResult ? (
            generationResult.isSuccess ? (
              
              /* 生成成功：经典票据版样式 */
              <div className="card" style={{ 
                border: '2px dashed hsl(var(--primary) / 0.4)',
                backgroundColor: 'hsl(var(--bg-card-hover) / 0.3)',
                padding: '1.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1.5rem',
                backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)',
                backgroundSize: '16px 16px'
              }}>
                {/* 票据头部 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px dashed hsl(var(--border))', paddingBottom: '1rem' }}>
                  <div>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: '800', fontFamily: 'var(--font-title)', color: 'hsl(var(--primary))' }}>
                      {t('slipTitle')}
                    </h3>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                      ID: {slipMeta?.id} | {slipMeta?.date}
                    </span>
                  </div>
                  <button 
                    onClick={handleCopySlip} 
                    className="btn btn-secondary" 
                    style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                  >
                    {copied ? <Check size={14} style={{ color: 'hsl(var(--primary))' }} /> : <Copy size={14} />}
                    <span>{copied ? t('copiedText') : t('copyBtn')}</span>
                  </button>
                </div>

                {/* 比赛列表 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {generationResult.selections.map((sel, sIdx) => {
                    const hTeam = getTeamById(sel.match.homeTeamId);
                    const aTeam = getTeamById(sel.match.awayTeamId);

                    return (
                      <div 
                        key={sIdx}
                        style={{
                          backgroundColor: 'hsl(var(--bg))',
                          border: '1px solid var(--border)',
                          borderRadius: '10px',
                          padding: '1rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.5rem'
                        }}
                      >
                        {/* 比赛名和时间 */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: 'hsl(var(--text-secondary))' }}>
                          <span>{new Date(sel.match.kickoffTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                          <span style={{ fontWeight: '600' }}>{getMarketLabel(sel.prediction.marketType, language)}</span>
                        </div>
                        {/* 对阵队伍 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', fontWeight: '700', fontSize: '0.9rem', color: 'hsl(var(--text-primary))' }}>
                          <TeamBadge team={hTeam} size="sm" />
                          <span>{hTeam.name[language]}</span>
                          <span style={{ color: 'hsl(var(--text-muted))' }}>vs</span>
                          <TeamBadge team={aTeam} size="sm" />
                          <span>{aTeam.name[language]}</span>
                        </div>
                        {/* 推荐详情 */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid hsl(var(--border))', paddingTop: '0.5rem', marginTop: '0.25rem' }}>
                          <span style={{ fontSize: '0.825rem', color: 'hsl(var(--primary))', fontWeight: '700' }}>
                            {getPredictionTipDisplay(sel.prediction, language)}
                          </span>
                          <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.8rem' }}>
                            <span>SP: <strong style={{ color: 'hsl(var(--accent))' }}>@{sel.prediction.odds.toFixed(2)}</strong></span>
                            <span>可信度: <strong style={{ color: 'hsl(var(--primary))' }}>{sel.prediction.trustScore}%</strong></span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 汇总栏 */}
                <div style={{ 
                  borderTop: '1px dashed hsl(var(--border))', 
                  paddingTop: '1.25rem',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '1rem',
                  textAlign: 'center'
                }}>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.75rem', borderRadius: '10px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('totalOdds')}</span>
                    <span style={{ fontSize: '1.5rem', fontWeight: '900', color: 'hsl(var(--accent))', fontFamily: 'var(--font-title)' }}>
                      @{generationResult.totalOdds}
                    </span>
                  </div>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.75rem', borderRadius: '10px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('avgTrust')}</span>
                    <span style={{ fontSize: '1.5rem', fontWeight: '900', color: 'hsl(var(--primary))', fontFamily: 'var(--font-title)' }}>
                      {generationResult.averageTrust}%
                    </span>
                  </div>
                </div>

              </div>
            ) : (
              /* 生成失败提示 */
              <div className="card" style={{ border: '1px solid hsl(var(--premium) / 0.2)', textAlign: 'center', padding: '2.5rem 1.5rem', color: 'hsl(var(--text-secondary))' }}>
                <ShieldAlert size={36} style={{ color: 'hsl(var(--premium))', marginBottom: '0.75rem' }} />
                <p style={{ fontSize: '0.9rem' }}>{generationResult.message[language]}</p>
              </div>
            )
          ) : (
            /* 默认空白板 */
            <div className="card" style={{ borderStyle: 'dashed', textAlign: 'center', padding: '5rem 2rem', color: 'hsl(var(--text-muted))' }}>
              <Sparkles size={40} style={{ marginBottom: '1rem', color: 'hsl(var(--border))', animation: 'float 3s infinite ease-in-out' }} />
              <h4 style={{ color: 'hsl(var(--text-secondary))', marginBottom: '0.5rem', fontWeight: '600' }}>
                {language === 'zh' ? '等待生成投注单' : 'Awaiting Accumulator Generation'}
              </h4>
              <p style={{ fontSize: '0.8rem' }}>
                {language === 'zh' ? '在左侧配置您的风险偏好、目标总SP以及可筛选市场，AI 算法将在几毫秒内为您输出最佳串关组合。' : 'Configure filters on the left. AI algorithms will compile the optimal ticket in milliseconds.'}
              </p>
            </div>
          )}

        </div>

      </div>

    </div>
  );
};
