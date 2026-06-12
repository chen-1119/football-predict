export type AccessSession = {
  token: string;
  expiresAt: string;
  issuedAt?: string;
  codeId?: string;
};

export const ACCESS_SESSION_STORAGE_KEY = 'football_access_session';

const parseJson = <T,>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const isAccessSessionValid = (session: AccessSession | null, now = Date.now()) => {
  if (!session?.token || !session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
};

export const readStoredAccessSession = (): AccessSession | null => {
  const session = parseJson<AccessSession>(localStorage.getItem(ACCESS_SESSION_STORAGE_KEY));
  return isAccessSessionValid(session) ? session : null;
};

export const persistAccessSession = (session: AccessSession) => {
  localStorage.setItem(ACCESS_SESSION_STORAGE_KEY, JSON.stringify(session));
};

export const clearStoredAccessSession = () => {
  localStorage.removeItem(ACCESS_SESSION_STORAGE_KEY);
};

export const getStoredAccessToken = () => readStoredAccessSession()?.token || '';

export const getAccessAuthHeaders = (): Record<string, string> => {
  const token = getStoredAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};

export const formatAccessCode = (value: string) => {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return normalized.replace(/(.{4})/g, '$1-').replace(/-$/, '');
};
