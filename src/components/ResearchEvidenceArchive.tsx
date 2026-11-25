import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createEvidenceArchiveClient, EVIDENCE_REQUEST_LIMIT, prepareEvidenceUpload, type PreparedEvidenceUpload } from '../services/researchEvidenceArchiveClient';

export function ResearchEvidenceArchive({ userId }: { userId: string }) {
  const [file, setFile] = useState<File | null>(null), [expectedHash, setExpectedHash] = useState('');
  const [prepared, setPrepared] = useState<PreparedEvidenceUpload | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const client = useRef<ReturnType<typeof createEvidenceArchiveClient> | null>(null), operation = useRef<AbortController | null>(null);
  const latch = useRef(false), generation = useRef(0);
  if (!client.current) client.current = createEvidenceArchiveClient();
  useEffect(() => {
    generation.current++;
    operation.current?.abort();
    setFile(null); setExpectedHash(''); setPrepared(null); setConfirmed(false); setError(''); setNotice('');
    return () => { generation.current++; operation.current?.abort(); };
  }, [userId]);
  function resetPrepared() { setPrepared(null); setConfirmed(false); setError(''); setNotice(''); }
  async function validateFile(event: FormEvent) {
    event.preventDefault();
    if (latch.current || !file) return;
    latch.current = true; setBusy(true); resetPrepared();
    const stamp = generation.current;
    try {
      if (file.size > EVIDENCE_REQUEST_LIMIT) throw Error('文件超过 1 MiB，不能截断上传。');
      const value = await prepareEvidenceUpload(new Uint8Array(await file.arrayBuffer()), expectedHash.trim());
      if (stamp === generation.current) { setPrepared(value); setNotice('文件及原文摘要已通过本地校验；事实、来源资格和时效仍须服务端重放。'); }
    } catch (cause) { if (stamp === generation.current) setError(cause instanceof Error ? cause.message : '文件校验失败。'); }
    finally { latch.current = false; setBusy(false); }
  }
  async function execute(write: boolean) {
    if (latch.current || !prepared || (write && (!confirmed || !client.current!.canArchive(prepared, userId)))) return;
    latch.current = true; setBusy(true); setError(''); setNotice('');
    const stamp = generation.current, controller = new AbortController(); operation.current = controller;
    try {
      const result = await client.current![write ? 'archive' : 'read'](prepared, userId, controller.signal);
      if (stamp === generation.current) setNotice(result.state === 'committed-readback-verified'
        ? `仅证据归档已独立读回验证；不是推荐发布。归档时间 ${result.archivedAt}，读回时间 ${result.observedAt}。`
        : '本次未观察到该原件；不等于此前提交失败，不会自动再次写入。');
    } catch (cause) { if (stamp === generation.current) setError(`${cause instanceof Error ? cause.message : '结果未确认。'} 已尝试的提交只能独立读回，不会自动重试写入。`); }
    finally { operation.current = null; latch.current = false; setBusy(false); }
  }
  return <section className="account-card" aria-labelledby="research-evidence-heading">
    <h2 id="research-evidence-heading">研究证据原件归档</h2>
    <p>仅保存已有证据包，不生成方向、不发布推荐、不配置投注或串关，也不替代缺失资料。使用当前运营/管理员登录会话，服务器仍执行原权限、来源和时效门禁。</p>
    <form className="account-form" onSubmit={validateFile}>
      <label htmlFor="research-evidence-file">已有 packet / evidence-archive 请求 JSON（完整文件不超过 1 MiB）</label>
      <input key={userId} id="research-evidence-file" type="file" accept=".json,application/json" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); resetPrepared(); }} />
      <label htmlFor="research-evidence-hash">从原件清单核对的文件 SHA-256</label>
      <input id="research-evidence-hash" value={expectedHash} maxLength={64} autoComplete="off" spellCheck={false} disabled={busy} onChange={event => { setExpectedHash(event.target.value); resetPrepared(); }} />
      <button type="submit" className="account-secondary" disabled={busy || !file || !/^[a-f0-9]{64}$/.test(expectedHash.trim())}>仅本地校验文件</button>
    </form>
    {prepared && <>
      <p>{prepared.eventLabel} · 请求 {prepared.requestBytes.toLocaleString()} 字节</p>
      <details><summary>核对原件与请求摘要</summary><dl className="account-facts">
        <dt>文件 SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{prepared.fileSha256}</dd>
        <dt>原件 payload SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{prepared.payloadSha256}</dd>
        <dt>contentHash</dt><dd style={{ overflowWrap: 'anywhere' }}>{prepared.contentHash}</dd>
        <dt>请求 SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{prepared.requestSha256}</dd>
        <dt>归档 key</dt><dd style={{ overflowWrap: 'anywhere' }}>{prepared.key}</dd>
      </dl></details>
      <label className="account-check"><input type="checkbox" checked={confirmed} disabled={busy || !client.current.canArchive(prepared, userId)} onChange={event => setConfirmed(event.target.checked)} />我已核对原件；此次仅归档，不是发布。结果未知时只读回，不重复提交。</label>
      <button type="button" className="account-primary" disabled={busy || !confirmed || !client.current.canArchive(prepared, userId)} onClick={() => void execute(true)}>仅归档，不发布</button>{' '}
      <button type="button" className="account-secondary" disabled={busy} onClick={() => void execute(false)}>独立读回（不写入）</button>
      {!client.current.canArchive(prepared, userId) && <p className="account-note">本浏览器标签页已保留尝试标记，或无法安全保存该标记；此原件只可读回。刷新或换文件后重选不会自动重试。</p>}
    </>}
    {busy && <p role="status">正在处理… <button type="button" className="account-secondary" disabled={!operation.current} onClick={() => operation.current?.abort()}>停止等待</button>；停止等待不代表服务器已取消，之后请独立读回。</p>}
    {error && <p className="account-error" role="alert">{error}</p>}
    {notice && <p className="account-note" role="status">{notice}</p>}
  </section>;
}
