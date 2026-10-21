/**
 * Pure mesh-payload helpers for the Contract D data-plane routes (W3 lane).
 *
 * Zero DB, zero clock, zero node imports (type-only adapter import is erased at
 * runtime) → fully unit-testable with `bun test` and byte-deterministic by
 * construction: `serializeMeshFile` re-wraps every nested object in the pinned
 * key order from worklog Contract A before `JSON.stringify`, so the stored
 * eos-mesh/1 bytes depend ONLY on (source file bytes, adapter) — never on
 * object-construction order, never on timestamps (Contract A: creation time
 * lives in the DB revision row, never in the file).
 *
 * The 422 message builders below are BYTE-PINNED acceptance strings:
 *  - `unsupportedDeriveMessage` must stay byte-identical to the derive-quantities
 *    route's inline template (pinned by mesh-meta.test.ts hand-written pins);
 *  - `notMeshMessage` is the pinned non-mesh 422 wording.
 */

import type { MeshElement, MeshPayload } from "@/engines/adapters/mesh"

/** Provenance block embedded in every stored eos-mesh/1 file (Contract A). */
export interface MeshGeneratedBy {
  engineKey: string
  engineVersion: string
  adapterScript: string
  /** sha256 hex of the adapter script content */
  adapterHash: string
}

/** Stored file format (pinned shape, pinned key order — Contract A). */
export interface MeshFile {
  format: "eos-mesh/1"
  units: "m"
  /** source up-axis, declared and preserved — the viewer rotates, never the file */
  upAxis: "z" | "y"
  /** linear deflection tolerance used, in meters */
  tolerance: number
  generatedBy: MeshGeneratedBy
  elements: MeshElement[]
}

/** Structural supertype of the bridge's `MeshResult` (accepts it as-is). */
export interface MeshBridgeResult {
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  mesh: MeshPayload
}

/**
 * Merge the bridge payload with its provenance into the pinned eos-mesh/1 file
 * shape. The bridge returns the payload WITHOUT generatedBy (Contract B: the
 * data plane adds it when storing); elements are re-wrapped in the pinned key
 * order and non-pinned extra keys are dropped so the stored format is exactly
 * Contract A.
 */
export function buildMeshFile(result: MeshBridgeResult): MeshFile {
  return {
    format: "eos-mesh/1",
    units: "m",
    upAxis: result.mesh.upAxis,
    tolerance: result.mesh.tolerance,
    generatedBy: {
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
    },
    elements: result.mesh.elements.map((el) => ({
      elementRef: el.elementRef,
      name: el.name,
      vertices: el.vertices,
      triangles: el.triangles,
    })),
  }
}

/**
 * Byte-deterministic serialization of an eos-mesh/1 file. Every nested object
 * is re-wrapped in the pinned key order right here (format → units → upAxis →
 * tolerance → generatedBy → elements; element: elementRef → name → vertices →
 * triangles) so two derives of the same source revision via the same adapter
 * produce byte-identical JSON — identical sha256, NO timestamps anywhere.
 */
export function serializeMeshFile(file: MeshFile): string {
  return JSON.stringify({
    format: file.format,
    units: file.units,
    upAxis: file.upAxis,
    tolerance: file.tolerance,
    generatedBy: {
      engineKey: file.generatedBy.engineKey,
      engineVersion: file.generatedBy.engineVersion,
      adapterScript: file.generatedBy.adapterScript,
      adapterHash: file.generatedBy.adapterHash,
    },
    elements: file.elements.map((el) => ({
      elementRef: el.elementRef,
      name: el.name,
      vertices: el.vertices,
      triangles: el.triangles,
    })),
  })
}

/** Aggregate counts for the 201 response + audit detail. */
export function meshCounts(file: MeshFile): {
  elementCount: number
  vertexCount: number
  triangleCount: number
} {
  return {
    elementCount: file.elements.length,
    vertexCount: file.elements.reduce((n, el) => n + el.vertices.length, 0),
    triangleCount: file.elements.reduce((n, el) => n + el.triangles.length, 0),
  }
}

/**
 * Contract D pinned formula, literally: the mesh's latest revision is stale
 * when its stored staleness left "current" (the existing staleness cascade
 * marks it when the source is revised) OR the revision it was derived from no
 * longer matches the source's latest revision. Both ids null (no recorded
 * derivation — e.g. a hand-registered mesh-kind upload) means the second
 * clause is false; staleness alone decides.
 */
export function computeStaleSource(
  staleness: string,
  derivedFromRevisionId: string | null,
  sourceLatestRevisionId: string | null,
): boolean {
  return staleness !== "current" || derivedFromRevisionId !== sourceLatestRevisionId
}

/**
 * Pinned 422 `unsupported` message — BYTE-IDENTICAL to the derive-quantities
 * route's inline template (same three-signal detection, same wording).
 */
export function unsupportedDeriveMessage(artifactName: string, storageKey: string): string {
  return `artifact "${artifactName}" (storage key ${storageKey}) does not carry a derivable model extension (.step/.stp/.ifc)`
}

/** Pinned 422 message for GET /api/artifacts/[id]/mesh on a non-mesh artifact. */
export function notMeshMessage(artifactName: string, kind: string): string {
  return `artifact "${artifactName}" is not a mesh (kind "${kind}")`
}

/** Best-effort provenance read from a parsed stored eos-mesh/1 file (GET route). */
export function extractGeneratedBy(mesh: unknown): {
  engineKey: string | null
  engineVersion: string | null
  adapterScript: string | null
  adapterHash: string | null
} {
  const empty = { engineKey: null, engineVersion: null, adapterScript: null, adapterHash: null }
  if (typeof mesh !== "object" || mesh === null) return empty
  const gb = (mesh as { generatedBy?: unknown }).generatedBy
  if (typeof gb !== "object" || gb === null) return empty
  const pick = (key: string): string | null => {
    const v = (gb as Record<string, unknown>)[key]
    return typeof v === "string" ? v : null
  }
  return {
    engineKey: pick("engineKey"),
    engineVersion: pick("engineVersion"),
    adapterScript: pick("adapterScript"),
    adapterHash: pick("adapterHash"),
  }
}
