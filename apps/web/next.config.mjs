import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** A separate web artifact. The browser receives no database credentials. */
export default {
  output: 'standalone',
  outputFileTracingRoot: root,
  poweredByHeader: false,
  reactStrictMode: true,
};
