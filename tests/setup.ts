/**
 * Vitest setup.
 *
 * Loads `.env` so integration tests can reach the local Postgres started by
 * `npm run infra:up`. Unit tests are pure and do not depend on this, but loading it
 * once here keeps the two suites configured identically.
 */
import "dotenv/config";
