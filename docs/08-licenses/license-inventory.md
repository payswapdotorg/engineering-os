# License Inventory

Owner: TL (platform) + W2 (engines) · Policy: [ADR-0004](../adr/0004-license-and-copyleft-boundary.md)

## 1. Platform license

Engineering OS platform code: **Apache-2.0** (`/LICENSE`).

## 2. Platform dependencies (runtime)

| Package | License (SPDX) | Notes |
|---|---|---|
| next, react, react-dom | MIT | framework |
| prisma / @prisma/client | Apache-2.0 | data layer |
| tailwindcss, tw-animate-css | MIT | styling |
| Radix UI primitives | MIT | component primitives |
| class-variance-authority, clsx, tailwind-merge | Apache-2.0/MIT/… | shadcn/ui toolchain |
| lucide-react | ISC | icons |
| zod | MIT | validation |
| sonner, next-themes, date-fns, uuid, framer-motion | MIT | product UX utilities |
| @tanstack/react-query, react-hook-form, @hookform/resolvers | MIT | client state/forms |
| next-auth | ISC | available; auth lands Phase 4 |

All of the above are permissive (MIT/Apache-2.0/ISC) — no copyleft in the platform's runtime dependency tree. (Exact versions: `package.json`; lockfile `bun.lock`.)

## 3. Engine candidates (upstream)

> Source-verified by Worker 2 via the upstream canonical repos (GitHub/GitLab APIs + repo LICENSE files) — see [engine-inventory.md](../02-engines/engine-inventory.md) for the authoritative, dated table, and [capability-matrix.md](../02-engines/capability-matrix.md) for capability states.

Integration policy (ADR-0004): engines run as separate processes; bundling/redistribution requires per-engine re-verification at release time. `installed` state never implies redistribution.

## 4. Supply-chain rule

License claims are verified against the **pinned source tree's own LICENSE/COPYING text**, not package metadata fields alone (a prior audit elsewhere in our org found a wheel whose COPYING.txt was pure GPLv3 while METADATA claimed MIT — metadata fields are hints, source text is truth).
