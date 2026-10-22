#!/usr/bin/env node
/**
 * Engineering OS — gen-postgres-schema.mjs (release-truth pass, 2026-10-22).
 *
 * Derives the PostgreSQL deployment schema from the canonical SQLite dev
 * schema. ADR-0003: the canonical prisma/schema.prisma is the SINGLE source
 * of truth; this script is the only sanctioned way to produce the PostgreSQL
 * variant, so the two can never drift silently:
 *
 *   - Local / CI check:  node scripts/gen-postgres-schema.mjs
 *     regenerates prisma/schema.postgres.prisma byte-deterministically (no
 *     timestamps); CI fails on any uncommitted drift (`git diff --exit-code`).
 *   - npm script:        bun run db:validate:postgres  (regenerate + validate)
 *
 * Production deployment path (ADR-0003 addendum): init/upgrade SQL is produced
 * by `prisma migrate diff` against THIS schema and applied with
 * `prisma db execute` (validated on live PostgreSQL in the CI
 * `db-portability` job). Dev keeps `bun run db:push` (safe default: no
 * --accept-data-loss; destructive dev resets are the explicit
 * `db:push:force`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = join(root, "prisma", "schema.prisma");
const outPath = join(root, "prisma", "schema.postgres.prisma");

const src = readFileSync(srcPath, "utf8");

const PROVIDER_RE = /provider\s*=\s*"sqlite"/;
if (!PROVIDER_RE.test(src)) {
  console.error(
    "gen-postgres-schema: expected `provider = \"sqlite\"` in prisma/schema.prisma — refusing to guess. " +
      "Update this script if the canonical provider declaration changed."
  );
  process.exit(1);
}

const banner = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with: node scripts/gen-postgres-schema.mjs  (byte-deterministic; CI
// fails the build on drift). Source of truth: prisma/schema.prisma (SQLite dev
// backend). This variant exists so the PostgreSQL production path (ADR-0003)
// is a real, validated artifact — not a documented assumption.
// Production init/upgrade: prisma migrate diff --to-schema-datamodel THIS FILE
// --script | prisma db execute  (see ADR-0003 addendum + CI db-portability job).

`;

const out = banner + src.replace(PROVIDER_RE, 'provider = "postgresql"');

writeFileSync(outPath, out, "utf8");
console.log(`gen-postgres-schema: wrote ${outPath} (${Buffer.byteLength(out)} bytes)`);
