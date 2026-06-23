import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock, Key, Loader2, MessageCircle, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContextCore';
import { formatAccessCode } from '../services/accessControl';

interface AuthProps {
  onSuccess: () => void;
}

const formatRemaining = (milliseconds: number, language: 'zh' | 'en') => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (language === 'zh') {
    return `${hours}小时 ${minutes}分 ${seconds}秒`;
  }

  return `${hours}h ${minutes}m ${seconds}s`;
};

const formatExpiry = (value: string | undefined, language: 'zh' | 'en') => {
  if (!value || Number.isNaN(Date.parse(value))) return '--';
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  });
};

export const Auth: React.FC<AuthProps> = ({ onSuccess }) => {
  const { language, accessSession, isAccessVerified, verifyAccessCode, clearAccessSession } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const qrSrc = `${import.meta.env.BASE_URL}contact-qr-code.jpg`;

  useEffect(() => {
    if (!isAccessVerified) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isAccessVerified]);

  const remainingMs = useMemo(() => {
    const expiresAt = Date.parse(accessSession?.expiresAt || '');
    return Number.isFinite(expiresAt) ? expiresAt - nowMs : 0;
  }, [accessSession?.expiresAt, nowMs]);

  const translations = {
    title: { zh: '推荐内容访问校验', en: 'Recommendation Access' },
    subtitle: {
      zh: '输入从微信获取的校验码后，可在有效期内查看推荐内容。',
      en: 'Enter the code received on WeChat to view recommendation content during its valid window.'
    },
    codeLabel: { zh: '6 小时校验码', en: '6-hour access code' },
    codePlaceholder: { zh: 'XXXX-XXXX-XXXX', en: 'XXXX-XXXX-XXXX' },
    submit: { zh: '验证并进入', en: 'Verify and enter' },
    submitting: { zh: '正在验证', en: 'Verifying' },
    contactTitle: { zh: '联系微信获取校验码', en: 'Contact on WeChat for a code' },
    contactNote: {
      zh: '扫码添加微信，确认后会收到一个从生成时刻起 6 小时有效的校验码。',
      en: 'Scan the WeChat QR code. After confirmation, you will receive a code valid for 6 hours from generation.'
    },
    verified: { zh: '已通过校验', en: 'Access verified' },
    expiresAt: { zh: '失效时间', en: 'Expires at' },
    remaining: { zh: '剩余有效期', en: 'Time remaining' },
    continue: { zh: '进入推荐内容', en: 'Open recommendations' },
    changeCode: { zh: '更换校验码', en: 'Use another code' },
    emptyCode: { zh: '请输入校验码', en: 'Please enter an access code' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!code.trim()) {
      setError(t('emptyCode'));
      return;
    }

    setIsSubmitting(true);
    try {
      await verifyAccessCode(code);
      onSuccess();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="access-page">
      <section className="access-card card">
        <div className="access-copy">
          <span className="access-kicker">
            <ShieldCheck size={16} />
            {t('title')}
          </span>
          <h2>{isAccessVerified ? t('verified') : t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>

        {isAccessVerified ? (
          <div className="access-verified-panel">
            <div className="access-status-grid">
              <span>
                <Clock size={16} />
                {t('remaining')}
                <strong>{formatRemaining(remainingMs, language)}</strong>
              </span>
              <span>
                <ShieldCheck size={16} />
                {t('expiresAt')}
                <strong>{formatExpiry(accessSession?.expiresAt, language)}</strong>
              </span>
            </div>
            <div className="access-action-row">
              <button type="button" onClick={onSuccess} className="btn btn-primary">
                <ArrowRight size={16} />
                <span>{t('continue')}</span>
              </button>
              <button type="button" onClick={clearAccessSession} className="btn btn-secondary">
                <Key size={16} />
                <span>{t('changeCode')}</span>
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="access-form">
            <label className="form-label" htmlFor="access-code">
              <Key size={14} />
              <span>{t('codeLabel')}</span>
            </label>
            <input
              id="access-code"
              type="text"
              className="form-input access-code-input"
              value={code}
              onChange={(event) => setCode(formatAccessCode(event.target.value))}
              placeholder={t('codePlaceholder')}
              autoComplete="one-time-code"
              inputMode="text"
            />

            {error && <div className="access-error" role="alert">{error}</div>}

            <button type="submit" className="btn btn-primary access-submit" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 size={16} className="spin-icon" /> : <ShieldCheck size={16} />}
              <span>{isSubmitting ? t('submitting') : t('submit')}</span>
            </button>
          </form>
        )}
      </section>

      <aside className="access-contact-panel">
        <div>
          <span className="access-kicker">
            <MessageCircle size={16} />
            {t('contactTitle')}
          </span>
          <p>{t('contactNote')}</p>
        </div>
        <img src={qrSrc} alt={t('contactTitle')} />
      </aside>
    </div>
  );
};
