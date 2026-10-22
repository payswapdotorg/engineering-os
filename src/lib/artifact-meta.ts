export const ARTIFACT_KINDS = [
  "model",
  "mesh", // engine-generated tessellation (derive-mesh); never detected from uploads
  "drawing",
  "document",
  "dataset",
  "calculation",
  "report",
  // Phase-5 extended disciplines (contract §2) — comment-only Prisma convention
  // mirroring the Phase-2 "mesh" precedent: these kinds are created ONLY by
  // their dedicated routes/ops, NEVER detected from uploads (an uploaded .json
  // stays "dataset", an uploaded .pdf stays "drawing" — KIND_BY_EXT below is
  // unchanged).
  "schedule", // user-authored project schedule JSON (POST /api/projects/[id]/schedules, eos-schedule/1)
  "fe-mesh", // engine-generated FE-mesh summary (gmsh via the fe_mesh broker op); never rendered by the Design Studio viewer (eos-mesh/1 only)
  "analysis", // engine- or platform-derived analysis results (power flow, DES, CPM)
  "pdf", // engine-generated PDF (LibreOffice conversion via convert_document)
  "other",
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  // models
  ifc: "model", ifczip: "model", fcstd: "model", fcstd1: "model",
  step: "model", stp: "model", stl: "model", obj: "model", "3mf": "model",
  blend: "model", skp: "model", dae: "model",
  // drawings
  dwg: "drawing", dxf: "drawing", pdf: "drawing", svg: "drawing", plt: "drawing",
  // documents
  md: "document", txt: "document", docx: "document", odt: "document", rtf: "document",
  odp: "document", pptx: "document", // presentations are deliverable documents
  fodt: "document", fods: "dataset", // flat-ODF (single-file XML) variants of odt/ods
  // datasets
  csv: "dataset", xlsx: "dataset", xls: "dataset", json: "dataset", xml: "dataset",
  geojson: "dataset", gpkg: "dataset", tif: "dataset", tiff: "dataset",
  // calculations
  py: "calculation", m: "calculation", ipynb: "calculation", toml: "calculation", yaml: "calculation",
  // reports
  html: "report",
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  geojson: "application/geo+json",
  xml: "application/xml",
  html: "text/html",
  step: "application/step",
  stp: "application/step",
  stl: "model/stl",
  obj: "text/plain",
  ifc: "application/x-step", // IFC is ISO 10303-21, same mime family as STEP
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  zip: "application/zip",
  ifczip: "application/zip",
  // office formats — LibreOffice import filters (Phase-5 convert route);
  // flat-ODF shares the packaged ODF mediatype per OASIS (LO sniffs the
  // serialization from content — verified live: fodt bytes named .odt convert
  // identically), so fodt/fods map like odt/ods.
  rtf: "application/rtf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  fodt: "application/vnd.oasis.opendocument.text",
  fods: "application/vnd.oasis.opendocument.spreadsheet",
}

function extOf(filename: string): string {
  const idx = filename.lastIndexOf(".")
  return idx > 0 ? filename.slice(idx + 1).toLowerCase() : ""
}

/** Best-effort classification by filename; client-declared kind always wins if valid. */
export function detectArtifactKind(filename: string): { kind: ArtifactKind; mimeType: string } {
  const ext = extOf(filename)
  return {
    kind: KIND_BY_EXT[ext] ?? "other",
    mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
  }
}

export function isArtifactKind(v: string): v is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(v)
}
