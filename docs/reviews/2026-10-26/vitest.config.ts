import { fileURLToPath } from 'node:url';
const mobile = fileURLToPath(new URL('../../../mobile/', import.meta.url));
export default {
  root: mobile,
  resolve: { alias: [
    { find: /^vitest$/, replacement: `${mobile}node_modules/vitest/dist/index.js` },
    { find: /^react$/, replacement: `${mobile}node_modules/react/index.js` },
    { find: 'react/jsx-runtime', replacement: `${mobile}node_modules/react/jsx-runtime.js` },
  ] },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: [fileURLToPath(new URL('./frontend.review.test.ts', import.meta.url)).replaceAll('\\', '/')],
  },
};
