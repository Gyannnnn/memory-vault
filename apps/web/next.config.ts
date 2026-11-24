import type { NextConfig } from 'next';

const config: NextConfig = {
  // Lets a second dev server run beside the usual one (e.g. against a test API).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: ['@memory-vault/shared', '@memory-vault/api-client', '@memory-vault/tokens'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Next.js would otherwise write an AGENTS.md into the project when it detects a coding agent.
  agentRules: false,
  // Keep the dev-only badge clear of the account menu in the sidebar's bottom-left corner.
  devIndicators: { position: 'bottom-right' },
};

export default config;
