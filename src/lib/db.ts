/**
 * Prisma client singleton, lazily constructed.
 *
 * Prisma 7 requires an explicit driver adapter (or an Accelerate URL) — the implicit
 * Rust query engine of earlier majors is gone, so `new PrismaClient()` with no
 * adapter is a type error. CollabOS uses the `pg` adapter against local Postgres.
 *
 * Why the Proxy: construction is deferred until the first property access. Modules
 * such as `lib/audit/log.ts` export pure helpers alongside database calls, and merely
 * importing one of those helpers (in a unit test, say) must not open a connection pool
 * or demand a valid DATABASE_URL. Eager construction made pure unit tests fail at
 * import time, which was a real coupling problem rather than a test inconvenience.
 *
 * The connection string is read through `loadEnv()` rather than `process.env`
 * directly, so the "must be PostgreSQL, never SQLite" guard applies here too.
 *
 * Next.js dev mode re-evaluates modules on hot reload, which would open a fresh
 * connection pool on every edit until Postgres refused new connections. Caching the
 * instance on `globalThis` is the standard remedy.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { loadEnv } from "../env.ts";
import { PrismaClient } from "../generated/prisma/client.ts";

const globalForPrisma = globalThis as unknown as {
  collabosPrisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const env = loadEnv();
  const adapter = new PrismaPg(env.DATABASE_URL);

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

function resolveClient(): PrismaClient {
  globalForPrisma.collabosPrisma ??= createPrismaClient();
  return globalForPrisma.collabosPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = resolveClient();
    const value = Reflect.get(client as object, property, receiver);
    // Model delegates are plain objects; client methods must keep their `this`.
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, property) {
    return Reflect.has(resolveClient() as object, property);
  },
});

export type { PrismaClient };
