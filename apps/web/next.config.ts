import type { NextConfig } from 'next';

const config: NextConfig = {
  // @readset/core ships built JS in dist (npm run build:core). We deliberately do NOT
  // transpile its source here: it uses NodeNext ".js" import suffixes that this bundler
  // cannot resolve, and the built output has no such problem.
  // solc and node:fs live inside core; keep them server-side, never bundled for the browser.
  serverExternalPackages: ['solc', '@readset/core'],
  typedRoutes: false,
};

export default config;
