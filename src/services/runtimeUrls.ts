const ABSOLUTE_URL_RE = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const normalizeRuntimeBase = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimTrailingSlash(trimmed) : null;
};

export const getDataApiBase = () => normalizeRuntimeBase(import.meta.env.VITE_DATA_API_BASE);

const getLocalPreviewApiBase = () => {
  if (typeof window === 'undefined') return null;

  const { hostname, port, protocol } = window.location;
  const isLocalHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const isVitePreviewPort = ['4173', '4174', '5173', '5174', '5175', '5176'].includes(port);
  if (!isLocalHost || !isVitePreviewPort) return null;

  return `${protocol}//${hostname}:8788`;
};

export const buildApiUrl = (endpoint: string) => {
  if (ABSOLUTE_URL_RE.test(endpoint)) return endpoint;

  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const apiBase = getDataApiBase() || (normalizedEndpoint.startsWith('/api/') ? getLocalPreviewApiBase() : null);
  if (!apiBase) return normalizedEndpoint;

  if (apiBase.endsWith('/api') && normalizedEndpoint.startsWith('/api/')) {
    return `${apiBase}${normalizedEndpoint.slice('/api'.length)}`;
  }

  return `${apiBase}${normalizedEndpoint}`;
};

export const buildStaticUrl = (path: string) => {
  if (ABSOLUTE_URL_RE.test(path)) return path;

  const base = import.meta.env.BASE_URL || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.replace(/^\.?\//, '');
  return `${normalizedBase}${normalizedPath}`;
};
