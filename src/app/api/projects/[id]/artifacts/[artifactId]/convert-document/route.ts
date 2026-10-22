import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { db } from "@/lib/db"

import { handler } from "../../../../../_lib/route-helpers"
import {
  alreadyPdfMessage,
  conversionGate,
  notConvertibleMessage,
} from "../../../../../_lib/convert-gate"
import { buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/convert-document — convert a
 * LibreOffice-importable document to PDF via the REAL headless soffice run and
 * store the raw application/pdf bytes as a DRAFT revision of a kind-"pdf"
 * artifact (contract §2/§8). Thin wrapper over
 * `runBrokerOperation("convert_document", …)`: the op core owns the
 * subprocess, find-or-create of the target artifact (derived_from this source)
 * and the ONE `document.converted` audit event. The PDF is served through the
 * existing artifact machinery (revision row + content store); byte-determinism
 * is honestly NOT claimed for conversions (PDFs embed creation timestamps — a
 * re-run appends a new revision with a different contentHash).
 *
 * The route gates convertible extensions FIRST (contract §5.4, the pinned
 * verbatim 422s): an already-PDF input refuses with `artifact "<name>" is
 * already a PDF`; anything outside the LO import-filter list refuses with
 * `artifact "<name>" is not convertible to PDF (no LibreOffice import filter
 * for this kind)`. Unknown project/artifact and revision-less artifacts fall
 * through to the op core's pinned 404/400 messages. Route-path audit actor is
 * the engine adapter (`adapter:libreoffice`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Convertibility gate (the route's pinned §5.4 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const gate = conversionGate(artifact.name, artifact.latestRevision.mimeType)
    if (gate.kind === "already-pdf") {
      return jsonError(422, "unsupported", alreadyPdfMessage(artifact.name))
    }
    if (gate.kind === "not-convertible") {
      return jsonError(422, "unsupported", notConvertibleMessage(artifact.name))
    }
  }

  try {
    const outcome = await runBrokerOperation(
      "convert_document",
      { projectId: id, actor: "adapter:libreoffice" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        pdf: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "document.converted",
          // Raw PDF bytes — served via the artifact machinery, never inlined.
          includeDocument: false,
        }),
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof BrokerRequestError) {
      if (err.code === "not_found") return ERR.notFound(err.what ?? "Resource")
      if (err.code === "bad_request") return ERR.badRequest(err.message)
      return ERR.invalid(err.message)
    }
    if (err instanceof BrokerRefusalError) {
      return jsonError(422, err.code, err.message)
    }
    throw err // unexpected adapter failure → honest 500 via handler, logged
  }
})
