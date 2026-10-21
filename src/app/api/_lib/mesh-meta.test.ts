/**
 * Worker 3 lane — Contract D mesh-payload helper tests (pure, byte-for-byte).
 *
 * Every expected string below is a HAND-WRITTEN pin of worklog Phase-2
 * Contract A (eos-mesh/1 file format: pinned key order, NO timestamps —
 * creation time lives in the DB revision row) and Contract D (pinned 422
 * wordings). The counts fixtures are hand-computed test data, not engineering
 * claims. The element refs mirror the quantity-adapter refs (STEP
 * `step:solid:<i>`, IFC `ifc:#<GlobalId>`) — the cross-reference contract.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import type { MeshElement, MeshPayload } from "@/engines/adapters/mesh"

import {
  buildMeshFile,
  computeStaleSource,
  extractGeneratedBy,
  meshCounts,
  notMeshMessage,
  serializeMeshFile,
  unsupportedDeriveMessage,
  type MeshBridgeResult,
} from "./mesh-meta"

// A minimal honest bridge result — one STEP solid, hand-written tetrahedron.
const stepResult: MeshBridgeResult = {
  engineKey: "cadquery",
  engineVersion: "2.6.1",
  adapterScript: "step_mesh.py",
  adapterHash: "a".repeat(64),
  mesh: {
    format: "eos-mesh/1",
    units: "m",
    upAxis: "z",
    tolerance: 0.0001,
    elements: [
      {
        elementRef: "step:solid:0",
        name: "Solid 1",
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        triangles: [
          [0, 1, 2],
          [0, 1, 3],
          [1, 2, 3],
          [0, 2, 3],
        ],
      },
    ],
  },
}

// Same derivation expressed with SCRAMBLED key order in every object plus a
// non-pinned extra key — the serializer must normalize to the pinned layout.
// (The `as MeshElement` assertion keeps the extra key in the RUNTIME object —
// proving serializeMeshFile drops non-pinned keys from the stored file.)
const scrambledElement = {
  name: "Basic Wall",
  triangles: [[0, 1, 2]],
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  elementRef: "ifc:#3_uPq2H8hbB9kXmOQ0ccalC",
  extra: "non-pinned key the file must never carry",
} as MeshElement

const scrambledResult: MeshBridgeResult = {
  engineKey: "ifcopenshell",
  engineVersion: "0.8.0",
  adapterScript: "ifc_mesh.py",
  adapterHash: "b".repeat(64),
  mesh: {
    format: "eos-mesh/1",
    units: "m",
    upAxis: "y",
    tolerance: 0.001,
    elements: [scrambledElement],
  },
}

describe("serializeMeshFile — pinned byte-for-byte eos-mesh/1 layout", () => {
  test("STEP result renders the exact pinned single-line JSON (key order Contract A)", () => {
    const json = serializeMeshFile(buildMeshFile(stepResult))
    const expected =
      `{"format":"eos-mesh/1","units":"m","upAxis":"z","tolerance":0.0001,` +
      `"generatedBy":{"engineKey":"cadquery","engineVersion":"2.6.1","adapterScript":"step_mesh.py","adapterHash":"${"a".repeat(64)}"},` +
      `"elements":[{"elementRef":"step:solid:0","name":"Solid 1",` +
      `"vertices":[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],` +
      `"triangles":[[0,1,2],[0,1,3],[1,2,3],[0,2,3]]}]}`
    expect(json).toBe(expected)
  })

  test("scrambled input keys + non-pinned extra keys still serialize to the pinned layout", () => {
    const json = serializeMeshFile(buildMeshFile(scrambledResult))
    const expected =
      `{"format":"eos-mesh/1","units":"m","upAxis":"y","tolerance":0.001,` +
      `"generatedBy":{"engineKey":"ifcopenshell","engineVersion":"0.8.0","adapterScript":"ifc_mesh.py","adapterHash":"${"b".repeat(64)}"},` +
      `"elements":[{"elementRef":"ifc:#3_uPq2H8hbB9kXmOQ0ccalC","name":"Basic Wall",` +
      `"vertices":[[0,0,0],[1,0,0],[0,1,0]],` +
      `"triangles":[[0,1,2]]}]}`
    expect(json).toBe(expected)
    expect(json.includes("extra")).toBe(false) // non-pinned key dropped from the stored file
  })

  test("byte-determinism: independent constructions of equal inputs → identical bytes", () => {
    const first = serializeMeshFile(buildMeshFile(stepResult))
    const again = serializeMeshFile(buildMeshFile(JSON.parse(JSON.stringify(stepResult))))
    expect(first).toBe(again)
  })

  test("NO timestamps anywhere in the file (Contract A: creation time lives in the DB row)", () => {
    const json = serializeMeshFile(buildMeshFile(stepResult))
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(json)).toBe(false) // no ISO-8601 date
    expect(json.includes("createdAt")).toBe(false)
    expect(json.includes("generatedAt")).toBe(false)
  })

  test("empty elements list is representable (honest zero-mesh, still pinned shape)", () => {
    const json = serializeMeshFile(
      buildMeshFile({
        engineKey: "cadquery",
        engineVersion: "2.6.1",
        adapterScript: "step_mesh.py",
        adapterHash: "c".repeat(64),
        mesh: {
          format: "eos-mesh/1",
          units: "m",
          upAxis: "z",
          tolerance: 0.0001,
          elements: [],
        } satisfies MeshPayload,
      }),
    )
    expect(json.endsWith('"elements":[]}')).toBe(true)
  })
})

describe("meshCounts — hand-computed aggregates", () => {
  test("two elements: vertices and triangles sum across elements", () => {
    const counts = meshCounts(
      buildMeshFile({
        engineKey: "ifcopenshell",
        engineVersion: "0.8.0",
        adapterScript: "ifc_mesh.py",
        adapterHash: "d".repeat(64),
        mesh: {
          format: "eos-mesh/1",
          units: "m",
          upAxis: "z",
          tolerance: 0.001,
          elements: [
            stepResult.mesh.elements[0], // 4 verts / 4 tris
            scrambledResult.mesh.elements[0], // 3 verts / 1 tri
          ],
        } satisfies MeshPayload,
      }),
    )
    expect(counts).toEqual({ elementCount: 2, vertexCount: 7, triangleCount: 5 })
  })

  test("zero elements → 0/0/0", () => {
    const counts = meshCounts(
      buildMeshFile({
        engineKey: "cadquery",
        engineVersion: "2.6.1",
        adapterScript: "step_mesh.py",
        adapterHash: "e".repeat(64),
        mesh: {
          format: "eos-mesh/1",
          units: "m",
          upAxis: "z",
          tolerance: 0.0001,
          elements: [],
        } satisfies MeshPayload,
      }),
    )
    expect(counts).toEqual({ elementCount: 0, vertexCount: 0, triangleCount: 0 })
  })
})

describe("computeStaleSource — Contract D pinned formula, literal", () => {
  test("current + derived-from-latest → false (fresh mesh)", () => {
    expect(computeStaleSource("current", "rev_1", "rev_1")).toBe(false)
  })

  test("staleness left \"current\" → true (the revisions cascade marked it)", () => {
    expect(computeStaleSource("stale", "rev_1", "rev_1")).toBe(true)
    expect(computeStaleSource("recomputing", "rev_1", "rev_1")).toBe(true)
  })

  test("derived-from revision no longer the source latest → true", () => {
    expect(computeStaleSource("current", "rev_1", "rev_2")).toBe(true)
  })

  test("no recorded derivation (both null) → staleness alone decides", () => {
    expect(computeStaleSource("current", null, null)).toBe(false)
    expect(computeStaleSource("stale", null, null)).toBe(true)
  })

  test("derived-from recorded but source latest unresolvable → true (honest mismatch)", () => {
    expect(computeStaleSource("current", "rev_1", null)).toBe(true)
  })
})

describe("pinned 422 wordings (byte-identical to the quantities route template)", () => {
  test("unsupported message matches the derive-quantities template byte-for-byte", () => {
    expect(unsupportedDeriveMessage("site-notes.md", "prj_smoke/art_notes/rev_v1")).toBe(
      'artifact "site-notes.md" (storage key prj_smoke/art_notes/rev_v1) does not carry a derivable model extension (.step/.stp/.ifc)',
    )
  })

  test("not-a-mesh message for a document-kind artifact", () => {
    expect(notMeshMessage("Site notes", "document")).toBe(
      'artifact "Site notes" is not a mesh (kind "document")',
    )
  })

  test("names with embedded quotes pass through the pinned formula verbatim", () => {
    expect(notMeshMessage('Wall "B"', "model")).toBe(
      'artifact "Wall "B"" is not a mesh (kind "model")',
    )
  })
})

describe("extractGeneratedBy — null-safe provenance read from a parsed file", () => {
  test("full generatedBy block resolves every field", () => {
    const mesh = JSON.parse(serializeMeshFile(buildMeshFile(stepResult)))
    expect(extractGeneratedBy(mesh)).toEqual({
      engineKey: "cadquery",
      engineVersion: "2.6.1",
      adapterScript: "step_mesh.py",
      adapterHash: "a".repeat(64),
    })
  })

  test("missing / malformed generatedBy → all nulls, never a throw", () => {
    expect(extractGeneratedBy(null)).toEqual({
      engineKey: null,
      engineVersion: null,
      adapterScript: null,
      adapterHash: null,
    })
    expect(extractGeneratedBy({ format: "eos-mesh/1", elements: [] })).toEqual({
      engineKey: null,
      engineVersion: null,
      adapterScript: null,
      adapterHash: null,
    })
    expect(extractGeneratedBy({ generatedBy: "not-an-object" })).toEqual({
      engineKey: null,
      engineVersion: null,
      adapterScript: null,
      adapterHash: null,
    })
  })

  test("partial generatedBy → present strings, absent nulls", () => {
    expect(extractGeneratedBy({ generatedBy: { engineKey: "cadquery" } })).toEqual({
      engineKey: "cadquery",
      engineVersion: null,
      adapterScript: null,
      adapterHash: null,
    })
  })
})
