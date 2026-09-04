import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContextCore';
import { generateBetSlip } from '../services/generator';
import type { BetSlipMarketType, BetSlipResult } from '../services/generator';
import { Sparkles, RefreshCw, Copy, Check, ShieldAlert, Award } from 'lucide-react';
import {
  getMarketLabel,
  getPredictionMarketLabel,
  getPredictionTipDisplay,
  getPredictionValueLabel
} from '../services/bettingDisplay';
import { getTeamById } from '../services/entities';
import { TeamBadge } from '../components/TeamBadge';
import { buildPublicRecommendationCopy } from '../services/recommendationCopy';
import { copyText } from '../services/clipboard';
import { getFormalRecommendationPrediction } from '../services/displayRecommendation';
import { formatEvidenceScore, isFormalPresentationAllowed } from '../services/predictionPresentation';

type TimeWindow = '1' | '2' | '3';
const ENABLED_BET_SLIP_MARKETS: BetSlipMarketType[] = ['1X2', 'HHAD'];

const getBetSlipMarketLabel = (market: BetSlipMarketType, language: 'zh' | 'en') => {
  if (market === 'HHAD') return language === 'zh' ? '让球' : 'Handicap';
  return getMarketLabel(market, language);
};

interface SlipMeta {
  id: string;
  date: string;
}

interface BetSlipGeneratorProps {
  onOpenObservations: () => void;
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

export const BetSlipGenerator: React.FC<BetSlipGeneratorProps> = ({ onOpenObservations }) => {
  const { language, matches, dataSync } = useApp();
  const liveDataReadyForCombination = dataSync.dataChannel !== 'retained'
    && dataSync.serviceTransitioning !== true
    && dataSync.currentRefreshHealthy === true;
  const formalPresentationAllowed = liveDataReadyForCombination && isFormalPresentationAllowed(
    dataSync.modelEvaluation?.backtest?.riskTiers?.overall?.tier,
    dataSync.sourceHealth?.fallbackCoverage?.servingMode || dataSync.sourceFallbackCoverage?.servingMode
  );
  const formalRecommendationCount = useMemo(() => (
    formalPresentationAllowed
      ? matches.filter((match) => Boolean(getFormalRecommendationPrediction(match))).length
      : 0
  ), [formalPresentationAllowed, matches]);
  const canGenerateCombination = liveDataReadyForCombination && formalRecommendationCount >= 2;
  const formalPoolSignature = useMemo(() => [
    formalPresentationAllowed ? 'stable' : 'blocked',
    liveDataReadyForCombination ? 'live-data' : 'retained-data',
    dataSync.modelEvaluation?.generatedAt || '',
    ...matches.map((match) => {
      const prediction = getFormalRecommendationPrediction(match);
      return prediction
        ? `${match.id}:${prediction.oddsPoolCode || ''}:${prediction.tipCode}:${prediction.odds}`
        : '';
    }).filter(Boolean).sort()
  ].join('|'), [dataSync.modelEvaluation?.generatedAt, formalPresentationAllowed, liveDataReadyForCombination, matches]);

  // 表单状态
  const [targetOdds, setTargetOdds] = useState<number>(2.00);
  const [matchCount, setMatchCount] = useState<'auto' | 2 | 3 | 5>('auto');
  const [selectedMarkets, setSelectedMarkets] = useState<BetSlipMarketType[]>(ENABLED_BET_SLIP_MARKETS);
  const [minOdds, setMinOdds] = useState<number>(1.20);
  const [maxOdds, setMaxOdds] = useState<number>(3.00);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('3');
  const [minTrust, setMinTrust] = useState<number>(62);
  
  // 生成结果
  const [generationResult, setGenerationResult] = useState<BetSlipResult | null>(null);
  const [generationPoolSignature, setGenerationPoolSignature] = useState('');
  const [slipMeta, setSlipMeta] = useState<SlipMeta | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);

  const displayedGenerationResult = canGenerateCombination
    && generationPoolSignature === formalPoolSignature
    ? generationResult
    : null;

  const translations = {
    title: { zh: '正式推荐组合工具', en: 'Formal Pick Combo Tool' },
    subtitle: {
      zh: '只组合官方已开售且通过全部发布门槛的正式推荐；参考推荐不会进入组合。',
      en: 'Combines only on-sale formal picks that pass every publication gate; reference picks never enter a combo.'
    },
    openNotice: { zh: '正式推荐门槛', en: 'Formal-pick gate' },
    referenceNotice: { zh: '提示：页面内容只供足球数据研究和赛前讨论参考，不构成投注建议。', en: 'Note: this page is for football data research and pre-match discussion only, not betting advice.' },
    targetOddsLabel: { zh: '目标组合值', en: 'Target Combined Value' },
    matchCountLabel: { zh: '串关比赛数量', en: 'Number of Selections' },
    auto: { zh: '智能推荐 (Auto)', en: 'Auto' },
    marketsLabel: { zh: '包含推荐玩法', en: 'Markets to Include' },
    minOddsLabel: { zh: '单场最低值', en: 'Min Single Value' },
    maxOddsLabel: { zh: '单场最高值', en: 'Max Single Value' },
    timeWindowLabel: { zh: '比赛时间窗口', en: 'Time Window' },
    minTrustLabel: { zh: '最低证据评分', en: 'Min Evidence Score' },
    generateBtn: { zh: '生成参考组合', en: 'Generate Reference Combo' },
    resetBtn: { zh: '重置配置', en: 'Reset Filters' },
    copyBtn: { zh: '复制参考组合', en: 'Copy Combo' },
    copiedText: { zh: '已复制！', en: 'Copied!' },
    copyFailed: { zh: '复制失败，请手动选择内容复制。', en: 'Copy failed. Please select and copy the content manually.' },
    slipTitle: { zh: '参考组合票据', en: 'Reference Ticket' },
    slipSummary: { zh: '参考汇总', en: 'Summary' },
    totalOdds: { zh: '组合总值', en: 'Total Value' },
    avgTrust: { zh: '平均证据评分', en: 'Avg Evidence Score' },
    activeSlip: { zh: '正式候选：', en: 'Formal candidates:' },
    unavailableTitle: { zh: '当前无法生成组合', en: 'Combo generation unavailable' },
    unavailableReason: { zh: '正式推荐池不足 2 条，组合器保持暂停。', en: 'The formal pool has fewer than two picks, so the combo tool stays paused.' },
    formalOnlyReason: { zh: '组合器只接收已开售的正式推荐，不会用参考推荐补位。', en: 'The tool accepts only on-sale formal picks and never fills gaps with reference picks.' },
    retainedDataReason: { zh: '服务切换期间仅展示上次已验证快照，组合器暂停；实时接口恢复后自动开放。', en: 'Only the last verified snapshot is shown during service cutover. Combo generation resumes automatically when the live API returns.' },
    openObservations: { zh: '查看参考推荐与阻断原因', en: 'View reference picks and blockers' },
    poolEmptyBtn: { zh: '正式池不足，暂不可生成', en: 'Formal pool insufficient' }
  };

  const t = (key: keyof typeof translations) => {
    return translations[key][language] || '';
  };

  const handleMarketToggle = (market: BetSlipMarketType) => {
    if (selectedMarkets.includes(market)) {
      if (selectedMarkets.length > 1) {
        setSelectedMarkets(selectedMarkets.filter(m => m !== market));
      }
    } else {
      setSelectedMarkets([...selectedMarkets, market]);
    }
  };

  const handleGenerate = () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    setErrorMsg(null);
    setCopyState('idle');

    if (!canGenerateCombination) {
      setGenerationResult(null);
      setGenerationPoolSignature('');
      setSlipMeta(null);
      setErrorMsg(liveDataReadyForCombination ? t('unavailableReason') : t('retainedDataReason'));
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
      onlyImportantLeagues: false,
      onlyOddsDropping: false
    }, matches);

    if (result.isSuccess) {
      setSlipMeta(createSlipMeta(result));
    } else {
      setSlipMeta(null);
    }
    setGenerationResult(result);
    setGenerationPoolSignature(formalPoolSignature);
  };

  const handleReset = () => {
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    setTargetOdds(2.00);
    setMatchCount('auto');
    setSelectedMarkets(ENABLED_BET_SLIP_MARKETS);
    setMinOdds(1.20);
    setMaxOdds(3.00);
    setTimeWindow('3');
    setMinTrust(62);
    setGenerationResult(null);
    setGenerationPoolSignature('');
    setSlipMeta(null);
    setErrorMsg(null);
    setCopyState('idle');
  };

  const handleCopySlip = async () => {
    if (!displayedGenerationResult) return;
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    const text = displayedGenerationResult.selections.map(s => {
      const homeTeam = getTeamById(s.match.homeTeamId);
      const awayTeam = getTeamById(s.match.awayTeamId);
      return `${homeTeam.shortName[language]} vs ${awayTeam.shortName[language]} | ${getPredictionMarketLabel(s.prediction, language)}: ${getPredictionTipDisplay(s.prediction, language)} @${s.prediction.odds}`;
    }).join('\n') + `\n${t('totalOdds')}: @${displayedGenerationResult.totalOdds}`;

    setCopyState('idle');
    try {
      const result = await copyText(text);
      if (!result.ok) throw new Error(result.error || 'copy failed');
      setCopyState('success');
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopyState('idle');
        copyFeedbackTimerRef.current = null;
      }, 2000);
    } catch {
      setCopyState('error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* 头部介绍 */}
      <div style={{ textAlign: 'center', maxWidth: '700px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-title)' }} className="gradient-text">
          {t('title')}
        </h1>
        <p style={{ color: 'hsl(var(--text-secondary))', fontSize: '0.9rem', marginTop: '0.5rem', lineHeight: '1.6' }}>
          {t('subtitle')}
        </p>
      </div>

      {/* 参考提示 */}
      <div className="card premium-card" style={{ 
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem',
        borderColor: 'hsl(var(--primary) / 0.3)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', maxWidth: '750px' }}>
          <div style={{ 
            backgroundColor: 'hsl(var(--primary) / 0.15)', 
            color: 'hsl(var(--primary))', 
            padding: '0.5rem', borderRadius: '10px' 
          }}>
            <Award size={20} />
          </div>
          <div>
            <p style={{ fontSize: '0.85rem', color: 'hsl(var(--text-primary))', fontWeight: '700' }}>
              {t('openNotice')} · {formalRecommendationCount} {language === 'zh' ? '条正式方向' : 'formal picks'}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'hsl(var(--text-secondary))', marginTop: '0.15rem' }}>
              {canGenerateCombination ? t('referenceNotice') : t('unavailableReason')}
            </p>
          </div>
        </div>
        {!canGenerateCombination && (
          <button type="button" className="btn btn-secondary" onClick={onOpenObservations}>
            {t('openObservations')}
          </button>
        )}
      </div>

      {/* 双栏布局 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '2rem', alignItems: 'start' }}>
        
        {/* 左栏：参数配置表单 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* 目标总SP */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label className="form-label" htmlFor="bet-slip-target-odds">{t('targetOddsLabel')}</label>
              <span style={{ color: 'hsl(var(--primary))', fontWeight: '800' }}>@{targetOdds.toFixed(2)}</span>
            </div>
            <input 
              id="bet-slip-target-odds"
              type="range" 
              min="1.50" 
              max="8.00"
              step="0.05"
              value={targetOdds} 
              onChange={(e) => setTargetOdds(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'hsl(var(--primary))' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'hsl(var(--text-muted))', marginTop: '0.2rem' }}>
              <span>@1.50</span>
              <span>@8.00</span>
            </div>
          </div>

          {/* 比赛数量 */}
          <div className="form-group" role="group" aria-labelledby="bet-slip-match-count-label">
            <span id="bet-slip-match-count-label" className="form-label">{t('matchCountLabel')}</span>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              {(['auto', 2, 3, 5] as const).map((cnt) => {
                const isSelected = matchCount === cnt;
                return (
                  <button
                    key={cnt}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setMatchCount(cnt)}
                    className="btn btn-secondary"
                    style={{
                      padding: '0.35rem 0.65rem',
                      fontSize: '0.8rem',
                      borderRadius: '8px',
                      backgroundColor: isSelected ? 'hsl(var(--accent) / 0.15)' : 'transparent',
                      borderColor: isSelected ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                      color: isSelected ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '0.25rem'
                    }}
                  >
                    <span>{cnt === 'auto' ? t('auto') : `${cnt}场`}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 包含市场 */}
          <div className="form-group" role="group" aria-labelledby="bet-slip-markets-label">
            <span id="bet-slip-markets-label" className="form-label">{t('marketsLabel')}</span>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              {[
                { id: '1X2' as const, label: getBetSlipMarketLabel('1X2', language) },
                { id: 'HHAD' as const, label: getBetSlipMarketLabel('HHAD', language) }
              ].map(m => {
                const isSelected = selectedMarkets.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleMarketToggle(m.id)}
                    className="btn btn-secondary"
                    style={{
                      padding: '0.35rem 0.65rem',
                      fontSize: '0.8rem',
                      borderRadius: '8px',
                      backgroundColor: isSelected ? 'hsl(var(--accent) / 0.15)' : 'transparent',
                      borderColor: isSelected ? 'hsl(var(--accent))' : 'hsl(var(--border))',
                      color: isSelected ? 'hsl(var(--text-primary))' : 'hsl(var(--text-secondary))',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '0.25rem'
                    }}
                  >
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 可信度阈值 */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label className="form-label" htmlFor="bet-slip-min-trust">{t('minTrustLabel')}</label>
              <span style={{ color: 'hsl(var(--primary))', fontWeight: '800' }}>{minTrust}/100</span>
            </div>
            <input 
              id="bet-slip-min-trust"
              type="range" 
              min="62"
              max="95" 
              step="5"
              value={minTrust} 
              onChange={(e) => setMinTrust(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: 'hsl(var(--primary))' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'hsl(var(--text-muted))', marginTop: '0.2rem' }}>
              <span>62/100</span>
              <span>95/100</span>
            </div>
          </div>

          {/* SP 过滤与时间窗口 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="bet-slip-min-odds">{t('minOddsLabel')}</label>
              <input 
                id="bet-slip-min-odds"
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
              <label className="form-label" htmlFor="bet-slip-max-odds">{t('maxOddsLabel')}</label>
              <input 
                id="bet-slip-max-odds"
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
            <label className="form-label" htmlFor="bet-slip-time-window">{t('timeWindowLabel')}</label>
            <select
              id="bet-slip-time-window"
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

          {/* 模拟生成按钮 */}
          <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <button disabled={!canGenerateCombination} onClick={handleGenerate} className="btn btn-primary" style={{ width: '100%', height: '48px', opacity: canGenerateCombination ? 1 : 0.55, cursor: canGenerateCombination ? 'pointer' : 'not-allowed' }}>
              <RefreshCw size={16} />
              <span>{canGenerateCombination ? t('generateBtn') : t('poolEmptyBtn')}</span>
            </button>
            <button onClick={handleReset} className="btn btn-secondary" style={{ width: '100%' }}>
              {t('resetBtn')}
            </button>
          </div>

          {/* 额度提示 */}
          <div style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', textAlign: 'center', marginTop: '0.25rem' }}>
            {t('activeSlip')} <span style={{ color: 'hsl(var(--primary))', fontWeight: 'bold' }}>
              {formalRecommendationCount}
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

          {displayedGenerationResult ? (
            displayedGenerationResult.isSuccess ? (
              
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
                    type="button"
                    onClick={() => void handleCopySlip()}
                    className="btn btn-secondary" 
                    style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                  >
                    {copyState === 'success' ? <Check size={14} style={{ color: 'hsl(var(--primary))' }} /> : <Copy size={14} />}
                    <span>{copyState === 'success' ? t('copiedText') : t('copyBtn')}</span>
                  </button>
                </div>
                {copyState !== 'idle' && (
                  <span
                    className={`access-copy-feedback is-${copyState === 'success' ? 'success' : 'warning'}`}
                    role="status"
                    aria-live="polite"
                  >
                    {copyState === 'success' ? t('copiedText') : t('copyFailed')}
                  </span>
                )}

                {/* 比赛列表 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {displayedGenerationResult.selections.map((sel, sIdx) => {
                    const hTeam = getTeamById(sel.match.homeTeamId);
                    const aTeam = getTeamById(sel.match.awayTeamId);
                    const publicCopy = buildPublicRecommendationCopy(sel.match, sel.prediction, language, {
                      pickLabel: getPredictionTipDisplay(sel.prediction, language)
                    });
                    const evidenceScore = formatEvidenceScore(sel.prediction);

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
                          <span style={{ fontWeight: '600' }}>{getPredictionMarketLabel(sel.prediction, language)}</span>
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
                            <span>{getPredictionValueLabel(sel.prediction, language)}: <strong style={{ color: 'hsl(var(--accent))' }}>@{sel.prediction.odds.toFixed(2)}</strong></span>
                            <span>{language === 'zh' ? '证据评分' : 'Evidence score'}: <strong style={{ color: 'hsl(var(--primary))' }}>{evidenceScore}</strong></span>
                          </div>
                        </div>
                        <p style={{ margin: 0, fontSize: '0.75rem', color: 'hsl(var(--text-secondary))', lineHeight: 1.5 }}>
                          {publicCopy.reasons[0]}
                        </p>
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
                      @{displayedGenerationResult.totalOdds}
                    </span>
                  </div>
                  <div style={{ backgroundColor: 'hsl(var(--bg))', padding: '0.75rem', borderRadius: '10px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', display: 'block' }}>{t('avgTrust')}</span>
                    <span style={{ fontSize: '1.5rem', fontWeight: '900', color: 'hsl(var(--primary))', fontFamily: 'var(--font-title)' }}>
                      {displayedGenerationResult.averageTrust}/100
                    </span>
                  </div>
                </div>

              </div>
            ) : (
              /* 生成失败提示 */
              <div className="card" style={{ border: '1px solid hsl(var(--premium) / 0.2)', textAlign: 'center', padding: '2.5rem 1.5rem', color: 'hsl(var(--text-secondary))' }}>
                <ShieldAlert size={36} style={{ color: 'hsl(var(--premium))', marginBottom: '0.75rem' }} />
                <p style={{ fontSize: '0.9rem' }}>{displayedGenerationResult.message[language]}</p>
                <button type="button" className="btn btn-secondary" onClick={onOpenObservations} style={{ marginTop: '1rem' }}>
                  {t('openObservations')}
                </button>
              </div>
            )
          ) : (
            canGenerateCombination ? (
              <div className="card" style={{ borderStyle: 'dashed', textAlign: 'center', padding: '5rem 2rem', color: 'hsl(var(--text-muted))' }}>
                <Sparkles size={40} style={{ marginBottom: '1rem', color: 'hsl(var(--border))', animation: 'float 3s infinite ease-in-out' }} />
                <h4 style={{ color: 'hsl(var(--text-secondary))', marginBottom: '0.5rem', fontWeight: '600' }}>
                  {language === 'zh' ? '等待生成正式组合' : 'Awaiting Formal Combo Generation'}
                </h4>
                <p style={{ fontSize: '0.8rem' }}>
                  {language === 'zh' ? '使用左侧安全范围参数筛选正式推荐，参考推荐不会进入组合。' : 'Use the bounded filters on the left to combine formal picks; reference picks are excluded.'}
                </p>
              </div>
            ) : (
              <div className="card" role="status" style={{ border: '1px solid hsl(var(--accent) / 0.3)', textAlign: 'left', padding: '1.5rem', color: 'hsl(var(--text-secondary))' }}>
                <ShieldAlert size={32} style={{ color: 'hsl(var(--accent))', marginBottom: '0.75rem' }} />
                <h4 style={{ color: 'hsl(var(--text-primary))', marginBottom: '0.75rem', fontWeight: 800 }}>{t('unavailableTitle')}</h4>
                <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.84rem', lineHeight: 1.65 }}>
                  <li>{t('unavailableReason')}</li>
                  <li>{t('formalOnlyReason')}</li>
                  <li>{language === 'zh' ? `当前正式推荐数量：${formalRecommendationCount}` : `Current formal-pick count: ${formalRecommendationCount}`}</li>
                </ul>
                <button type="button" className="btn btn-secondary" onClick={onOpenObservations} style={{ width: '100%', marginTop: '1.25rem' }}>
                  {t('openObservations')}
                </button>
              </div>
            )
          )}

        </div>

      </div>

    </div>
  );
};
