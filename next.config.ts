import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma 7 ships a generated TypeScript client plus a `pg`-backed driver adapter.
  // These must stay external to the server bundle rather than being traced and
  // rewritten by the bundler.
  //
  // Note: Next 16 removed the top-level `eslint` config key, so linting is wired up
  // purely as the standalone `npm run lint` quality gate.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
