export const ARTIFACT_KINDS = [
  "model",
  "mesh", // engine-generated tessellation (derive-mesh); never detected from uploads
  "drawing",
  "document",
  "dataset",
  "calculation",
  "report",
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
