# Artifact Graph Schema

Version: 0.1 (Phase 1 subset) · Owner: TL (schema) + W3 (logic in `src/core`) · Normative source: `prisma/schema.prisma` + `src/core/index.ts`

## 1. Entities

| Entity | Ids | Key fields | Notes |
|---|---|---|---|
| Project | `prj_<uuid>` | slug (unique), name, discipline (see `src/lib/disciplines.ts`), description, status | One graph root per project |
| Artifact | `art_<uuid>` | kind (`model|drawing|document|dataset|calculation|report|other`), name, description, latestRevisionId | Stable identity across revisions |
| ArtifactRevision | `rev_<uuid>` | revNumber (per-artifact, sequential), contentHash (SHA-256), sizeBytes, storageKey, mimeType, note, approvalState, staleness, uploadedBy | The versioned, hash-anchored node |
| ArtifactLink | `lnk_<uuid>` | fromArtifactId, toArtifactId, relationType, createdBy | Typed edge between artifacts (latest-revision semantics at Phase 1) |
| TeamMember | `mem_<uuid>` | name, email?, role (`owner|editor|viewer`) | Phase 1: local model, creator is owner; auth with Phase 4 |
| Workflow | `wfl_<uuid>` | name, state, definition (JSON text) | Schema now; durable execution ships Phase 4 — no execution is claimed |
| AuditEvent | `evt_<uuid>` | projectId?, actorType (`user|agent|system`), actorId, action, entityType, entityId, detail (JSON text) | Append-only |

## 2. Relation types (exhaustive; validated in `src/core`)

| Relation | Meaning (A → B reads "A {rel} B") | In change-impact set? |
|---|---|---|
| `derived_from` | A derived from source B | **yes** |
| `analyzes` | A analyzes B | **yes** |
| `quantifies` | A quantifies B | **yes** |
| `validates` | A validates B | **yes** |
| `depends_on` | A depends on B | **yes** |
| `supersedes` | A replaces B (e.g. revised drawing supersedes issued one) | no |
| `scheduled_as` | A is scheduled as B (task/control link) | no |
| `approved_by` | A approved by B (reviewer/identity) | no |

Impact semantics: when B changes (new revision), every A with an impact-relation to B is **marked stale** with the graph path as evidence; recomputation is an explicit reviewed workflow — downstream outputs are **never silently overwritten**.

## 3. State machines

Approval (per revision): `draft → in_review → approved → superseded` (approve action supersedes prior approved revision of the same artifact; invalid transitions rejected — see `applyApproval` in `src/core`).

Staleness (per revision): `current → stale → recomputing → current` (`recompute_failed` returns to `stale` with evidence; see `nextStaleness`).

## 4. Identifiers, hashing, storage

- IDs: `<prefix>_<uuid v4>` (sortable ULIDs may replace via ADR if scale demands).
- Content: SHA-256 of the exact bytes; stored at `data/artifacts/<projectId>/<artifactId>/<revisionId>/content` via `src/lib/artifact-store.ts`.
- Provenance chain: every revision row records uploader, note, hash and storageKey; every link records who created it; every state change emits an `AuditEvent`.

## 5. Phase roadmap for the schema

- Phase 2: engine-owned artifacts, revision diffs/compare, requirements entities.
- Phase 3: quantity ledger + estimating entities (see [quantity-ledger-schema.md](quantity-ledger-schema.md)); review/issue states.
- Phase 4: workflow steps/lineage tables, identities (auth), approval records.
- Schema version bumps are ADR-recorded; migrations never silently drop data.
