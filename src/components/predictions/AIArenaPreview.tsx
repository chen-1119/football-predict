import React from 'react';
import { ArrowRight, Bot, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContextCore';
import { arenaPickLabel, buildDailyArenaSelection } from '../../services/aiArena';
import type { Match } from '../../services/mockData';
import '../../styles/ai-arena.css';

interface AIArenaPreviewProps {
  matches: Match[];
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

export const AIArenaPreview: React.FC<AIArenaPreviewProps> = ({ matches }) => {
  const { language } = useApp();
  const selection = React.useMemo(() => buildDailyArenaSelection(matches), [matches]);

  return (
    <section className="ai-arena-preview" aria-labelledby="ai-arena-preview-title">
      <div className="ai-arena-preview__heading">
        <div>
          <span className="ai-arena-kicker"><Sparkles size={15} aria-hidden="true" /> AI 单关竞技场</span>
          <h2 id="ai-arena-preview-title">{language === 'zh' ? '今日 AI 精选单关' : 'Today AI single-match challenge'}</h2>
          <p>{language === 'zh'
            ? '只从已确认单关、已开售官方 HAD SP 且模型概率完整的比赛中选择一场。'
            : 'One match selected only from confirmed singles with official HAD SP and complete model probabilities.'}</p>
        </div>
        <span className="ai-arena-preview__disclosure"><ShieldCheck size={14} aria-hidden="true" />
          {language === 'zh' ? '6 个策略模拟角色 · 非外部大模型实调' : '6 simulated strategy roles · no external-model calls'}
        </span>
      </div>

      {!selection ? (
        <div className="ai-arena-empty">
          <Bot size={26} aria-hidden="true" />
          <div>
            <strong>{language === 'zh' ? '今日暂无满足条件的单关' : 'No eligible single match today'}</strong>
            <p>{language === 'zh'
              ? '不会用普通比赛、未开售赔率或历史 SP 凑数；官方单关到达后自动显示。'
              : 'Regular fixtures, unopened prices, and historical SP are never used as filler.'}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="ai-arena-matchline">
            <div className="ai-arena-matchline__teams">
              <span>{selection.match.leagueShortName || selection.match.leagueName || '竞彩'}</span>
              <strong>{selection.match.homeTeamName || '主队'} <em>VS</em> {selection.match.awayTeamName || '客队'}</strong>
              <small>{new Date(selection.match.kickoffTime).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })}</small>
            </div>
            <div className="ai-arena-score"><span>AI Score</span><strong>{selection.aiScore}</strong></div>
            <div className="ai-arena-consensus">
              <span>{language === 'zh' ? '今日共识' : 'Consensus'}</span>
              <strong>{selection.consensus.votes}/{selection.consensus.total} {arenaPickLabel(selection.consensus.code, language)}</strong>
            </div>
          </div>

          <div className="ai-arena-probabilities" aria-label={language === 'zh' ? '模型胜平负概率' : 'Model 1X2 probabilities'}>
            {(['1', 'X', '2'] as const).map((code) => (
              <div key={code}>
                <span>{arenaPickLabel(code, language)} <b>{pct(selection.probabilities[code])}</b></span>
                <i><u style={{ width: pct(selection.probabilities[code]) }} /></i>
                <small>SP {selection.odds[code].toFixed(2)}</small>
              </div>
            ))}
          </div>

          <div className="ai-arena-daily-compare">
            {selection.analysts.map((row) => (
              <div key={row.id} className={`ai-arena-role is-${row.risk}`}>
                <span>{language === 'zh' ? row.nameZh : row.nameEn}</span>
                <strong>{arenaPickLabel(row.pick, language)}</strong>
                <small>{language === 'zh' ? '信心' : 'Confidence'} {row.confidence} · {language === 'zh' ? '模拟仓位' : 'Sim stake'} {row.stake}</small>
              </div>
            ))}
          </div>

          <div className="ai-arena-preview__footer">
            <p>{language === 'zh'
              ? '积分、仓位和排名均为模拟展示；本阶段不会计入正式模型命中率。'
              : 'Points, stakes, and rankings are simulated and excluded from formal model performance.'}</p>
            <Link to={`/ai-arena/${encodeURIComponent(selection.match.id)}`}>
              {language === 'zh' ? '查看 6 个策略详细对比' : 'Open six-role comparison'} <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </>
      )}
    </section>
  );
};

