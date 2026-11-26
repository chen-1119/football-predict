export const EVIDENCE_REQUEST_LIMIT = 1024 * 1024;
const PACKET_VERSION = 'reviewed-research-evidence-v1';
const REQUEST_VERSION = 'research-broker-request-v1';
const encoder = new TextEncoder();
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (message: string): never => { throw new Error(message); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('文件或响应结构无效。');
  return value as Record<string, unknown>;
};
const clock = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return fail('时间凭证无效。');
  return Date.parse(value);
};
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
function stable(value: unknown, depth = 0): unknown {
  if (depth > 32) return fail('文件嵌套超过校验上限。');
  if (typeof value === 'number' && !Number.isFinite(value)) return fail('文件包含无效数字。');
  if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0).map(([key, item]) => [key, stable(item, depth + 1)]));
  return value;
}

export interface PreparedEvidenceUpload {
  readonly fileSha256: string;
  readonly payloadSha256: string;
  readonly requestSha256: string;
  readonly contentHash: string;
  readonly key: string;
  readonly createdAt: string;
  readonly eventLabel: string;
  readonly requestBytes: number;
  readonly archiveBody: string;
  readonly readBody: string;
}
export interface EvidenceReadback {
  state: 'not-observed' | 'committed-readback-verified';
  key: string;
  payloadSha256?: string;
  contentHash?: string;
  archivedAt?: string;
  observedAt?: string;
}

export async function prepareEvidenceUpload(bytes: Uint8Array, expectedFileSha256: string): Promise<PreparedEvidenceUpload> {
  if (bytes.length < 2 || bytes.length > EVIDENCE_REQUEST_LIMIT) return fail('文件不得超过 1 MiB，不能截断上传。');
  const fileSha256 = await sha256(bytes);
  if (!hex(expectedFileSha256) || fileSha256 !== expectedFileSha256) return fail('文件 SHA-256 不符；未发送任何请求。');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const decodedBytes = encoder.encode(text);
  if (decodedBytes.length !== bytes.length || decodedBytes.some((value, index) => value !== bytes[index])) return fail('文件必须为无损 UTF-8，不自动移除或更改原始字节。');
  const uploaded = object(JSON.parse(text));
  let packet: Record<string, unknown>, archiveBody: string, payloadJson: string;
  if (uploaded.version === REQUEST_VERSION) {
    if (Object.keys(uploaded).sort().join(',') !== 'action,json,sha256,version' || uploaded.action !== 'evidence-archive' || typeof uploaded.json !== 'string' || !hex(uploaded.sha256)) return fail('仅接受 evidence-archive 请求，不接受发布或重试动作。');
    packet = object(JSON.parse(uploaded.json));
    payloadJson = uploaded.json;
    if (JSON.stringify(packet) !== payloadJson || await sha256(encoder.encode(payloadJson)) !== uploaded.sha256) return fail('请求内原件字节或 SHA-256 不符。');
    archiveBody = text;
  } else {
    packet = uploaded;
    payloadJson = JSON.stringify(packet);
    archiveBody = JSON.stringify({ version: REQUEST_VERSION, action: 'evidence-archive', json: payloadJson, sha256: await sha256(encoder.encode(payloadJson)) });
  }
  if (packet.version !== PACKET_VERSION || packet.verification !== 'human-reviewed-literal-evidence' || packet.formalEligible !== false || packet.modelProbability !== null || packet.expectedValue !== null) return fail('仅接受研究证据原件包，不接受模型推荐或发布稿。');
  const { contentHash, ...body } = packet;
  if (!hex(contentHash) || await sha256(encoder.encode(JSON.stringify(stable(body)))) !== contentHash) return fail('证据 contentHash 校验失败。');
  if (typeof packet.createdAt !== 'string' || packet.createdAt !== packet.reviewedAt) return fail('证据审核时间不一致。');
  clock(packet.createdAt);
  const event = object(packet.event);
  if (typeof event.eventId !== 'string' || !/^[1-9]\d{0,19}$/.test(event.eventId) || !Array.isArray(event.teams) || event.teams.length !== 2 || !event.teams.every(team => typeof team === 'string' && team.length > 0 && team.length <= 100)) return fail('证据赛事身份无效。');
  if (!Array.isArray(packet.sources) || packet.sources.length < 1 || packet.sources.length > 16) return fail('证据原文列表无效。');
  for (const input of packet.sources) {
    const source = object(input);
    if (typeof source.rawBase64 !== 'string' || !hex(source.rawSha256)) return fail('原文摘要无效。');
    const binary = atob(source.rawBase64), raw = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (btoa(binary) !== source.rawBase64 || raw.length < 1 || raw.length !== source.rawBytes || await sha256(raw) !== source.rawSha256) return fail('证据原文 SHA-256 或字节数不符。');
  }
  const requestBytes = encoder.encode(archiveBody).length;
  if (requestBytes > EVIDENCE_REQUEST_LIMIT) return fail('封装后请求超过 1 MiB，不能分段、裁剪或放宽限制。');
  const payloadSha256 = await sha256(encoder.encode(payloadJson)), key = 'team-evidence-' + contentHash;
  return Object.freeze({ fileSha256, payloadSha256, contentHash, key, createdAt: packet.createdAt, eventLabel: `${event.eventId} · ${event.teams.join(' — ')}`, requestBytes, archiveBody, requestSha256: await sha256(encoder.encode(archiveBody)), readBody: JSON.stringify({ version: REQUEST_VERSION, action: 'evidence-read', key, sha256: payloadSha256 }) });
}

function validateReadback(input: unknown, expected: PreparedEvidenceUpload, now: number, requireCommitted = false): EvidenceReadback {
  const value = object(input);
  if (value.ok !== true || value.key !== expected.key || value.archiveOnly !== true || value.published !== false || value.retryWriteAutomatically !== false) return fail('归档响应未验证，不能认定成功；仅可独立读回。');
  if (value.state === 'not-observed' && !requireCommitted && value.verified === false && value.commitAcknowledged !== true && value.payloadSha256 === undefined && value.contentHash === undefined) return { state: 'not-observed', key: expected.key };
  if (value.state !== 'committed-readback-verified' || value.verified !== true || value.commitAcknowledged !== true || value.payloadSha256 !== expected.payloadSha256 || value.contentHash !== expected.contentHash) return fail('归档摘要或提交确认不符；仅可独立读回。');
  const archived = clock(value.archivedAt), observed = clock(value.observedAt);
  if (archived < clock(expected.createdAt) || archived > observed || observed > now) return fail('归档或读回时间凭证不符；仅可独立读回。');
  return { state: 'committed-readback-verified', key: expected.key, payloadSha256: expected.payloadSha256, contentHash: expected.contentHash, archivedAt: value.archivedAt as string, observedAt: value.observedAt as string };
}

export function createEvidenceArchiveClient(options: { fetcher?: typeof fetch; storage?: Pick<Storage, 'getItem' | 'setItem'>; now?: () => number } = {}) {
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now, attempted = new Set<string>();
  let busy = false;
  const storage = () => options.storage ?? sessionStorage;
  const attemptKey = (prepared: PreparedEvidenceUpload, userId: string) => 'football.research.evidence.attempt.v1.' + encodeURIComponent(userId) + '.' + prepared.key + '.' + prepared.payloadSha256;
  function canArchive(prepared: PreparedEvidenceUpload, userId: string): boolean {
    try { return Boolean(userId) && !attempted.has(attemptKey(prepared, userId)) && storage().getItem(attemptKey(prepared, userId)) === null; } catch { return false; }
  }
  async function request(path: '/api/account/me' | '/api/operator/research/evidence' | '/api/operator/research/evidence-read', signal: AbortSignal, body?: string, csrf?: string) {
    if (signal.aborted) return fail('操作已取消；已发送的归档结果须独立读回。');
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf! }) }, ...(body === undefined ? {} : { body }) });
    if (!response.ok) return fail('服务器拒绝或未确认操作；不要重复提交，先独立读回。');
    const text = await response.text();
    if (encoder.encode(text).length > 16384 || signal.aborted) return fail('响应未完成或超出上限；仅可独立读回。');
    return object(JSON.parse(text));
  }
  async function session(expectedUserId: string, signal: AbortSignal): Promise<string> {
    const value = await request('/api/account/me', signal), user = object(value.user);
    if (value.ok !== true || !expectedUserId || user.id !== expectedUserId || user.status !== 'active' || !['operator', 'admin'].includes(String(user.role)) || typeof value.csrfToken !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(value.csrfToken) || clock(value.sessionExpiresAt) <= now()) return fail('需要当前有效的运营或管理员会话；未发送归档。');
    return value.csrfToken;
  }
  async function run(prepared: PreparedEvidenceUpload, userId: string, write: boolean, externalSignal?: AbortSignal): Promise<EvidenceReadback> {
    if (busy) return fail('已有操作正在进行，不能重复点击。');
    busy = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000), abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    try {
      if (write && !canArchive(prepared, userId)) return fail('此原件已经尝试提交或无法保存防重复标记；现在仅允许独立读回。');
      const csrf = await session(userId, controller.signal);
      let committed: EvidenceReadback | undefined;
      if (write) {
        if (controller.signal.aborted) return fail('操作已取消，未开始提交。');
        if (!canArchive(prepared, userId)) return fail('此原件已在另一操作中尝试提交；现在仅允许独立读回。');
        storage().setItem(attemptKey(prepared, userId), 'read-only-after-attempt');
        if (storage().getItem(attemptKey(prepared, userId)) !== 'read-only-after-attempt') return fail('防重复标记未保存，拒绝提交。');
        attempted.add(attemptKey(prepared, userId));
        const result = await request('/api/operator/research/evidence', controller.signal, prepared.archiveBody, csrf);
        if (typeof result.submitted !== 'boolean') return fail('提交确认字段无效；仅可独立读回。');
        committed = validateReadback(result, prepared, now(), true);
      }
      const readCsrf = write ? await session(userId, controller.signal) : csrf;
      const readback = validateReadback(await request('/api/operator/research/evidence-read', controller.signal, prepared.readBody, readCsrf), prepared, now(), write);
      if (committed && (readback.archivedAt !== committed.archivedAt || clock(readback.observedAt) < clock(committed.observedAt))) return fail('独立读回与首次回执不一致，不能认定归档成功。');
      return readback;
    } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); busy = false; }
  }
  return { canArchive, archive: (prepared: PreparedEvidenceUpload, userId: string, signal?: AbortSignal) => run(prepared, userId, true, signal), read: (prepared: PreparedEvidenceUpload, userId: string, signal?: AbortSignal) => run(prepared, userId, false, signal) };
}
