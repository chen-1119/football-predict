import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from '../context/AccountContext';
import { accountRequest, type AccountUser } from '../services/accountApi';
import '../styles/account.css';

type UserRow = AccountUser & { createdAt: string };
type Operation = 'grant' | 'status' | 'role';
const roleLabel = { user: '用户', operator: '运营', admin: '管理员' };
const errorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : '操作未完成，请稍后重试。';
  return ({ reauthentication_required: '当前密码不正确，请重新输入。', insufficient_role: '当前账号没有此项操作权限。',
    reason_required: '请填写操作理由。', invalid_grant_days: '赠送天数需为 1 至 365 的整数。',
    cannot_change_own_admin_state: '不能修改自己的管理员角色或账号状态。', authentication_required: '登录已失效，请重新登录。',
    authentication_rate_limited: '操作过于频繁，请稍后重试。' } as Record<string, string>)[message] || message;
};

export function AccountAdmin() {
  const account = useAccount();
  const [rows, setRows] = useState<UserRow[]>([]), [selectedId, setSelectedId] = useState('');
  const [operation, setOperation] = useState<Operation>('grant'), [days, setDays] = useState('3');
  const [status, setStatus] = useState<'active' | 'blocked'>('blocked'), [role, setRole] = useState<AccountUser['role']>('user');
  const [reason, setReason] = useState(''), [currentPassword, setCurrentPassword] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const allowed = account.user?.role === 'admin' || account.user?.role === 'operator';
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!allowed) return;
    setLoading(true); setError('');
    try {
      const value = await accountRequest<{ ok: true; rows: UserRow[] }>('/admin/users', { signal });
      if (!signal?.aborted) setRows(value.rows);
    } catch (cause) { if (!signal?.aborted) setError(errorMessage(cause)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [allowed]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, account.user?.id]);
  const candidates = account.user?.role === 'operator' ? rows.filter(user => user.role === 'user') : rows;
  const selected = candidates.find(user => user.id === selectedId);
  const effectiveOperation = account.user?.role === 'operator' ? 'grant' : operation;
  const forbiddenSelf = effectiveOperation !== 'grant' && selectedId === account.user?.id;
  const validDays = Number.isSafeInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 365;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !selected || forbiddenSelf || !reason.trim() || !currentPassword || (effectiveOperation === 'grant' && !validDays)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await account.accountAction(`/admin/users/${encodeURIComponent(selected.id)}/${effectiveOperation}`, {
        reason: reason.trim(), currentPassword,
        ...(effectiveOperation === 'grant' ? { days: Number(days) } : effectiveOperation === 'status' ? { status } : { role })
      });
      setCurrentPassword(''); setReason('');
      setNotice(effectiveOperation === 'grant' ? `已为 ${selected.username} 赠送 ${days} 天内容权限。`
        : effectiveOperation === 'status' ? `已${status === 'blocked' ? '禁用' : '启用'} ${selected.username}，原登录会话已撤销。`
          : `已更新 ${selected.username} 的角色，原登录会话已撤销。`);
      await load();
      if (selected.id === account.user?.id) await account.refresh();
    } catch (cause) { setCurrentPassword(''); setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  if (account.loading) return <div className="account-page"><p role="status">正在读取管理权限…</p></div>;
  if (!allowed) return <div className="account-page"><section className="account-card"><h1>体验管理</h1><p>此页面仅供运营和管理员使用。</p><Link to={account.user ? '/account' : '/auth?returnTo=%2Faccount-admin'} className="account-primary">{account.user ? '返回我的账号' : '登录账号'}</Link></section></div>;
  return <div className="account-page">
    <header className="account-heading account-heading-row"><div><span className="account-eyebrow">账号运营</span><h1>体验管理</h1><p>为指定用户赠送内容权限；所有变更都保留操作人、理由和时间。</p></div><button type="button" className="account-secondary" disabled={loading || busy} onClick={() => void load()}>{loading ? '读取中…' : '刷新列表'}</button></header>
    {error && <p className="account-error" role="alert">{error}</p>}{notice && <p className="account-success" role="status">{notice}</p>}
    <div className="account-grid">
      <section className="account-card"><h2>选择用户</h2><p>显示最近注册的 100 个账号。运营只能为普通用户赠送权限。</p>
        <div className="account-form"><label htmlFor="admin-target">目标账号</label><select id="admin-target" value={selectedId} onChange={event => { setSelectedId(event.target.value); setNotice(''); }} disabled={busy || loading}><option value="">请选择账号</option>{candidates.map(user => <option key={user.id} value={user.id}>{user.displayName} · {user.username} · {user.status === 'blocked' ? '已禁用' : roleLabel[user.role]}</option>)}</select></div>
        {selected ? <dl className="account-facts"><dt>账号</dt><dd>{selected.username}</dd><dt>显示名称</dt><dd>{selected.displayName}</dd><dt>角色</dt><dd>{roleLabel[selected.role]}</dd><dt>状态</dt><dd>{selected.status === 'active' ? '正常' : '已禁用'}</dd></dl> : <p className="account-muted">选择账号后核对身份，再执行操作。</p>}
      </section>
      <section className="account-card"><h2>执行操作</h2><form className="account-form" onSubmit={submit}>
        {account.user?.role === 'admin' && <><label htmlFor="admin-operation">操作类型</label><select id="admin-operation" value={operation} onChange={event => setOperation(event.target.value as Operation)} disabled={busy}><option value="grant">赠送内容权限</option><option value="status">禁用 / 启用账号</option><option value="role">变更账号角色</option></select></>}
        {effectiveOperation === 'grant' ? <><label htmlFor="admin-days">赠送天数</label><input id="admin-days" type="number" min="1" max="365" step="1" value={days} onChange={event => setDays(event.target.value)} required disabled={busy}/><p className="account-note">从本次操作成功时开始计时，不叠加已有权益，也不会重新开放一次性的 3 天体验。</p></>
          : effectiveOperation === 'status' ? <><label htmlFor="admin-status">新的账号状态</label><select id="admin-status" value={status} onChange={event => setStatus(event.target.value as 'active' | 'blocked')} disabled={busy}><option value="blocked">禁用账号</option><option value="active">启用账号</option></select></>
            : <><label htmlFor="admin-role">新的角色</label><select id="admin-role" value={role} onChange={event => setRole(event.target.value as AccountUser['role'])} disabled={busy}><option value="user">用户</option><option value="operator">运营</option><option value="admin">管理员</option></select></>}
        {forbiddenSelf && <p className="account-error" role="alert">不能修改自己的管理员角色或账号状态。</p>}
        <label htmlFor="admin-reason">操作理由</label><textarea id="admin-reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} maxLength={200} required disabled={busy}/>
        <label htmlFor="admin-password">再次输入你当前账号的密码</label><input id="admin-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} maxLength={128} required disabled={busy}/>
        <button type="submit" className="account-primary" disabled={busy || loading || !selected || forbiddenSelf || !reason.trim() || !currentPassword || (effectiveOperation === 'grant' && !validDays)}>{busy ? '正在处理…' : '确认执行'}</button>
      </form></section>
    </div>
  </div>;
}
