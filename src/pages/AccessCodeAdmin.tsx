import React, { useEffect, useMemo, useState } from 'react';
import { Ban, Check, Clipboard, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContextCore';

type GeneratedAccessCode = {
  id: string;
  code: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  usedAt?: string | null;
  lastUsedAt?: string | null;
  usedCount?: number;
  status?: AccessCodeRow['status'];
  ttlSeconds: number;
};

type AccessCodeRow = {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  usedAt?: string | null;
  lastUsedAt?: string | null;
  usedCount?: number;
  status: 'active' | 'expired' | 'revoked';
};

const formatDateTime = (value: string | undefined, language: 'zh' | 'en') => {
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

const getStatusLabel = (status: AccessCodeRow['status'], language: 'zh' | 'en') => {
  if (status === 'active') return language === 'zh' ? '有效' : 'Active';
  if (status === 'revoked') return language === 'zh' ? '已撤销' : 'Revoked';
  return language === 'zh' ? '已过期' : 'Expired';
};

export const AccessCodeAdmin: React.FC = () => {
  const { language } = useApp();
  const queryToken = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
  const [adminToken, setAdminToken] = useState(() => queryToken || sessionStorage.getItem('football_admin_token') || '');
  const [label, setLabel] = useState('');
  const [generatedCode, setGeneratedCode] = useState<GeneratedAccessCode | null>(null);
  const [rows, setRows] = useState<AccessCodeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const translations = {
    title: { zh: '校验码生成', en: 'Access Code Generator' },
    subtitle: {
      zh: '生成一个从当前时间开始 6 小时有效的校验码，发送给微信用户完成访问认证。',
      en: 'Generate a code valid for 6 hours from now and send it to the user on WeChat.'
    },
    token: { zh: '管理员 Token', en: 'Admin token' },
    tokenHint: {
      zh: '对应服务端 ACCESS_CODE_ADMIN_TOKEN；未单独设置时使用 ADMIN_TOKEN。不能为空。',
      en: 'Matches ACCESS_CODE_ADMIN_TOKEN; falls back to ADMIN_TOKEN when unset. It cannot be empty.'
    },
    label: { zh: '备注', en: 'Label' },
    labelPlaceholder: { zh: '例如：张三 20:00', en: 'Example: user 20:00' },
    generate: { zh: '生成 6 小时代码', en: 'Generate 6h code' },
    generating: { zh: '正在生成', en: 'Generating' },
    latest: { zh: '最新校验码', en: 'Latest code' },
    copy: { zh: '复制', en: 'Copy' },
    copied: { zh: '已复制', en: 'Copied' },
    expiresAt: { zh: '失效时间', en: 'Expires at' },
    recent: { zh: '最近生成记录', en: 'Recent codes' },
    refresh: { zh: '刷新', en: 'Refresh' },
    status: { zh: '状态', en: 'Status' },
    usage: { zh: '使用状态', en: 'Usage' },
    used: { zh: '已使用', en: 'Used' },
    unused: { zh: '未使用', en: 'Unused' },
    revoke: { zh: '撤销', en: 'Revoke' },
    revoked: { zh: '已撤销', en: 'Revoked' },
    createdAt: { zh: '生成时间', en: 'Created' },
    emptyRows: { zh: '暂无生成记录', en: 'No codes yet' }
  };

  const t = (key: keyof typeof translations) => translations[key][language] || '';

  const adminHeaders = () => ({
    'content-type': 'application/json',
    ...(adminToken.trim() ? { authorization: `Bearer ${adminToken.trim()}` } : {})
  });

  const loadRows = async () => {
    setIsLoadingRows(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/access-codes', {
        headers: adminHeaders(),
        cache: 'no-store'
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setRows(Array.isArray(payload?.rows) ? payload.rows : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoadingRows(false);
    }
  };

  useEffect(() => {
    if (adminToken.trim()) {
      sessionStorage.setItem('football_admin_token', adminToken.trim());
    }
  }, [adminToken]);

  useEffect(() => {
    if (adminToken.trim()) {
      const timer = window.setTimeout(() => {
        void loadRows();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    // Load once when a remembered or query token exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerate = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsGenerating(true);
    setCopied(false);
    try {
      const response = await fetch('/api/admin/access-codes', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ label: label.trim() })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.code) throw new Error(payload?.error || `HTTP ${response.status}`);
      setGeneratedCode(payload as GeneratedAccessCode);
      setLabel('');
      await loadRows();
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
    } finally {
      setIsGenerating(false);
    }
  };

  const copyCode = async () => {
    if (!generatedCode?.code) return;
    await navigator.clipboard.writeText(generatedCode.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const revokeCode = async (codeId: string) => {
    setError(null);
    setRevokingId(codeId);
    try {
      const response = await fetch(`/api/admin/access-codes/${encodeURIComponent(codeId)}/revoke`, {
        method: 'POST',
        headers: adminHeaders()
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (generatedCode?.id === codeId) {
        setGeneratedCode((current) => current ? { ...current, revokedAt: new Date().toISOString(), status: 'revoked' } : current);
      }
      await loadRows();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="access-admin-page">
      <section className="access-admin-head">
        <span className="access-kicker">
          <ShieldCheck size={16} />
          {t('title')}
        </span>
        <h2>{t('title')}</h2>
        <p>{t('subtitle')}</p>
      </section>

      <section className="access-admin-grid">
        <form className="card access-admin-form" onSubmit={handleGenerate}>
          <label className="form-label" htmlFor="admin-token">
            <KeyRound size={14} />
            <span>{t('token')}</span>
          </label>
          <input
            id="admin-token"
            className="form-input"
            type="password"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="off"
          />
          <small>{t('tokenHint')}</small>

          <label className="form-label" htmlFor="access-label">{t('label')}</label>
          <input
            id="access-label"
            className="form-input"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('labelPlaceholder')}
          />

          {error && <div className="access-error" role="alert">{error}</div>}

          <button type="submit" className="btn btn-primary access-submit" disabled={isGenerating}>
            {isGenerating ? <Loader2 size={16} className="spin-icon" /> : <Plus size={16} />}
            <span>{isGenerating ? t('generating') : t('generate')}</span>
          </button>
        </form>

        <section className="card access-code-result">
          <span className="access-kicker">{t('latest')}</span>
          {generatedCode ? (
            <>
              <strong className="generated-code">{generatedCode.code}</strong>
              <span className="generated-expiry">
                {t('expiresAt')}: {formatDateTime(generatedCode.expiresAt, language)}
              </span>
              <div className="access-action-row">
                <button type="button" className="btn btn-secondary" onClick={copyCode}>
                  {copied ? <Check size={16} /> : <Clipboard size={16} />}
                  <span>{copied ? t('copied') : t('copy')}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => revokeCode(generatedCode.id)}
                  disabled={generatedCode.status === 'revoked' || Boolean(generatedCode.revokedAt) || revokingId === generatedCode.id}
                >
                  {revokingId === generatedCode.id ? <Loader2 size={16} className="spin-icon" /> : <Ban size={16} />}
                  <span>{generatedCode.status === 'revoked' || generatedCode.revokedAt ? t('revoked') : t('revoke')}</span>
                </button>
              </div>
            </>
          ) : (
            <p>{t('subtitle')}</p>
          )}
        </section>
      </section>

      <section className="card access-code-table-card">
        <div className="access-table-head">
          <strong>{t('recent')}</strong>
          <button type="button" className="btn btn-secondary" onClick={loadRows} disabled={isLoadingRows}>
            {isLoadingRows ? <Loader2 size={16} className="spin-icon" /> : <RefreshCw size={16} />}
            <span>{t('refresh')}</span>
          </button>
        </div>

        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="responsive-table access-code-table">
              <thead>
                <tr>
                  <th>{t('label')}</th>
                  <th>{t('createdAt')}</th>
                  <th>{t('expiresAt')}</th>
                  <th>{t('status')}</th>
                  <th>{t('usage')}</th>
                  <th>{language === 'zh' ? '操作' : 'Action'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label || row.id.slice(0, 8)}</td>
                    <td>{formatDateTime(row.createdAt, language)}</td>
                    <td>{formatDateTime(row.expiresAt, language)}</td>
                    <td>
                      <span className={`access-status is-${row.status}`}>
                        {getStatusLabel(row.status, language)}
                      </span>
                    </td>
                    <td>
                      <span className={`access-used is-${row.usedAt ? 'used' : 'unused'}`}>
                        {row.usedAt ? `${t('used')} ${formatDateTime(row.lastUsedAt || row.usedAt, language)}` : t('unused')}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary access-row-action"
                        disabled={row.status === 'revoked' || revokingId === row.id}
                        onClick={() => revokeCode(row.id)}
                      >
                        {revokingId === row.id ? <Loader2 size={14} className="spin-icon" /> : <Ban size={14} />}
                        <span>{row.status === 'revoked' ? t('revoked') : t('revoke')}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="access-empty">{t('emptyRows')}</p>
        )}
      </section>
    </div>
  );
};
