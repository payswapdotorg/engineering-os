#!/usr/bin/env bash
# scripts/e2e-p2-modelviewer.sh — Design Studio model-viewer regression (Phase-2
# record: 67 PASS / 0 FAIL). Rebuilt from AC-P2-01…07 evidence in
# docs/06-qa/acceptance-catalogue.md: real STEP/IFC tessellation round-trips,
# the elementRef cross-reference contract with the quantity ledger,
# byte-determinism on re-derive, the Journey-G staleness ride + regenerate,
# honest 422 gates with zero side effects, the pinned eos-mesh/1 GET payload,
# and the harness `validation` registry evidence.
#
# Creates a throwaway probe project ("AC-P2 modelviewer probe") and removes it
# at the end (bun scripts/dev-db-cleanup.ts --project …; KEPT on failure for
# forensics). Run any time after e2e-takeoff.sh. Pure HTTP: curl + jq + python3.
# Final line "N PASS / M FAIL", nonzero exit on any FAIL.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$(cd "$HERE/.." && pwd)/tests/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'PASS %2d: %s\n' "$PASS" "$1"; }
bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL %2d: %s\n' "$FAIL" "$1"
  printf '  actual (truncated): %.600s\n' "$2"
  printf '  (expected: %.300s)\n' "$3"
}
assert_eq() { # desc expected actual
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1" "$3" "$2"; fi
}

STATUS=""
BODY=""
http() { # method path [extra curl args…]
  local method="$1" path="$2"
  shift 2
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@") || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
upload() { # path file kind [explicit artifact name]
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path") || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }

# ===========================================================================
# 1-3. Fresh probe project + the two real-model fixtures
# ===========================================================================
cat > "$WORK/proj.json" <<'EOF'
{ "name": "AC-P2 modelviewer probe", "discipline": "structural", "description": "Throwaway mesh/mesh-viewer probe (e2e-p2-modelviewer.sh)" }
EOF
http POST /api/projects -H 'Content-Type: application/json' --data-binary @"$WORK/proj.json"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201|AC-P2 modelviewer probe" \
  "$STATUS|$(j "$BODY" '.data.project.name')"
if [[ -z "$PROBE_ID" ]]; then echo "FATAL: no probe project"; exit 1; fi

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids.step"
SOLIDS_ID=$(j "$BODY" '.data.artifact.id')
SOLIDS_REV1=$(j "$BODY" '.data.artifact.latestRevision.id')
LOCAL_SHA=$(sha256sum "$FIXTURES/two-solids.step" | cut -d' ' -f1)
assert_eq "two-solids.step registered (201, kind model, contentHash == local sha256)" \
  "201|model|$LOCAL_SHA" "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.latestRevision.contentHash')"

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-elements.ifc" model "two-elements.ifc"
ELEMENTS_ID=$(j "$BODY" '.data.artifact.id')
ELEMENTS_REV1=$(j "$BODY" '.data.artifact.latestRevision.id')
assert_eq "two-elements.ifc registered (201, kind model, rev 1)" \
  "201|model|1" "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.latestRevision.revNumber')"

# ===========================================================================
# 4. Ledger first on two-solids (the cross-reference contract fixture)
# ===========================================================================
http POST "/api/projects/$PROBE_ID/artifacts/$SOLIDS_ID/derive-quantities"
SOLIDS_Q="$BODY"
VAL_OK=$(python3 -c 'import sys, json
rows = json.loads(sys.argv[1])["data"]["quantities"]
by_ref = {r["elementRef"]: r["value"] for r in rows}
checks = [
    abs(by_ref["step:solid:0"] - 6000) <= 1e-9,
    abs(by_ref["step:solid:1"] - 9000) <= 1e-9,
    abs(by_ref["step:solids:all"] - 5050) <= 1e-9,
    abs(by_ref["step:model:bbox"] - 123.38962679253066) <= 1e-6,
]
sys.exit(0 if all(checks) else 1)' "$SOLIDS_Q" 2>/dev/null && echo ok || echo bad)
assert_eq "derive-quantities on two-solids.step: 201, 4 rows (6000 / 9000 mm³, 5050 mm², bbox √15225 mm), pinned step refs" \
  "201|4|step:model:bbox,step:solid:0,step:solid:1,step:solids:all|ok" \
  "$STATUS|$(j "$SOLIDS_Q" '.data.quantities | length')|$(j "$SOLIDS_Q" '[.data.quantities[].elementRef] | sort | join(",")')|$VAL_OK"

# ===========================================================================
# 5-16. AC-P2-01 STEP mesh derivation round-trip (REAL cadquery tessellation)
# ===========================================================================
http POST "/api/projects/$PROBE_ID/artifacts/$SOLIDS_ID/derive-mesh"
MESH1="$BODY"
MESH_ID=$(j "$MESH1" '.data.mesh.artifactId')
MESH1_HASH=$(j "$MESH1" '.data.mesh.contentHash')
assert_eq "derive-mesh 201 + mesh artifact id returned" "201|set" "$STATUS|$( [[ -n "$MESH_ID" && "$MESH_ID" != "null" ]] && echo set || echo missing)"
assert_eq "mesh name is the pinned derived name" "two-solids.step — 3D mesh" "$(j "$MESH1" '.data.mesh.name')"
assert_eq "mesh kind" "mesh" "$(j "$MESH1" '.data.mesh.kind')"
assert_eq "first derive appends revision 1" "1" "$(j "$MESH1" '.data.mesh.revisionNumber')"
assert_eq "elementCount 2 (two solids)" "2" "$(j "$MESH1" '.data.mesh.elementCount')"
assert_eq "vertexCount 48 (2 × 24)" "48" "$(j "$MESH1" '.data.mesh.vertexCount')"
assert_eq "triangleCount 24 (2 × 12)" "24" "$(j "$MESH1" '.data.mesh.triangleCount')"
assert_eq "engine cadquery 2.6.1" "cadquery|2.6.1" "$(j "$MESH1" '.data.mesh.engineKey')|$(j "$MESH1" '.data.mesh.engineVersion')"
assert_eq "adapterScript step_mesh.py" "step_mesh.py" "$(j "$MESH1" '.data.mesh.adapterScript')"
assert_eq "adapterHash is a 64-hex sha256" "true" "$(j "$MESH1" '.data.mesh.adapterHash | test("^[0-9a-f]{64}$")')"
assert_eq "derivedFrom == the SOURCE artifact + its latest revision (queue-time truth)" \
  "$SOLIDS_ID|$SOLIDS_REV1" "$(j "$MESH1" '.data.mesh.derivedFromArtifactId')|$(j "$MESH1" '.data.mesh.derivedFromRevisionId')"
assert_eq "fresh derivation: staleSource false + sourceLatestRevisionId == source latest + 64-hex contentHash" \
  "false|$SOLIDS_REV1|true" "$(j "$MESH1" '.data.mesh.staleSource')|$(j "$MESH1" '.data.mesh.sourceLatestRevisionId')|$(j "$MESH1" '.data.mesh.contentHash | test("^[0-9a-f]{64}$")')"

# ===========================================================================
# 17-20. Exactly ONE mesh.derived audit event + the derived_from link
# ===========================================================================
http GET "/api/events?projectId=$PROBE_ID&limit=200"
MESH1_EVENTS=$(printf '%s' "$BODY" | /usr/bin/jq -c "[.data.events[] | select(.action == \"mesh.derived\" and .entityId == \"$MESH_ID\")] | .[0].detail | fromjson")
assert_eq "exactly ONE mesh.derived audit event for the mesh artifact (actor adapter:cadquery)" \
  "1|adapter:cadquery" "$(j "$BODY" "[.data.events[] | select(.action == \"mesh.derived\" and .entityId == \"$MESH_ID\")] | length")|$(j "$BODY" "[.data.events[] | select(.action == \"mesh.derived\" and .entityId == \"$MESH_ID\")][0].actorId")"
assert_eq "audit detail: engineKey/engineVersion/adapterScript/adapterHash + sourceArtifactId/sourceRevisionId + revisionNumber 1" \
  "cadquery|2.6.1|step_mesh.py|$SOLIDS_ID|$SOLIDS_REV1|1" \
  "$(j "$MESH1_EVENTS" '.engineKey')|$(j "$MESH1_EVENTS" '.engineVersion')|$(j "$MESH1_EVENTS" '.adapterScript')|$(j "$MESH1_EVENTS" '.sourceArtifactId')|$(j "$MESH1_EVENTS" '.sourceRevisionId')|$(j "$MESH1_EVENTS" '.revisionNumber')"
assert_eq "audit detail carries the pinned counts + sha256 == mesh contentHash" \
  "2|48|24|$MESH1_HASH" \
  "$(j "$MESH1_EVENTS" '.elementCount')|$(j "$MESH1_EVENTS" '.vertexCount')|$(j "$MESH1_EVENTS" '.triangleCount')|$(j "$MESH1_EVENTS" '.sha256')"

http GET "/api/artifacts/$MESH_ID"
assert_eq "derived_from ArtifactLink present (mesh → source, createdBy adapter:cadquery)" \
  "derived_from|$SOLIDS_ID|adapter:cadquery" \
  "$(j "$BODY" '.data.artifact.linksFrom[0].relationType')|$(j "$BODY" '.data.artifact.linksFrom[0].toArtifact.id')|$(j "$BODY" '.data.artifact.linksFrom[0].createdBy')"

# ===========================================================================
# 21-29. AC-P2-02 IFC mesh branch + the elementRef set-equality contract
# ===========================================================================
http POST "/api/projects/$PROBE_ID/artifacts/$ELEMENTS_ID/derive-quantities"
ELEM_Q="$BODY"
ELEM_REFS_OK=$(j "$ELEM_Q" '[.data.quantities[].elementRef] | unique | sort | join(",")')
assert_eq "derive-quantities on two-elements.ifc: 201, 15 rows across the 3 walls (5+6+4 per the corpus), authored BaseQuantities" \
  "201|15|5|6|4|#3rUnE8CnPHBwLdZzIqZkf1,#3rUnE8CnPHBwLdZzIqZkf2,#3rUnE8CnPHBwLdZzIqZkf3" \
  "$STATUS|$(j "$ELEM_Q" '.data.quantities | length')|$(j "$ELEM_Q" '[.data.quantities[] | select(.elementRef == "#3rUnE8CnPHBwLdZzIqZkf1")] | length')|$(j "$ELEM_Q" '[.data.quantities[] | select(.elementRef == "#3rUnE8CnPHBwLdZzIqZkf2")] | length')|$(j "$ELEM_Q" '[.data.quantities[] | select(.elementRef == "#3rUnE8CnPHBwLdZzIqZkf3")] | length')|$ELEM_REFS_OK"

http POST "/api/projects/$PROBE_ID/artifacts/$ELEMENTS_ID/derive-mesh"
MESH2="$BODY"
MESH2_ID=$(j "$MESH2" '.data.mesh.artifactId')
assert_eq "derive-mesh on two-elements.ifc: 201" "201" "$STATUS"
assert_eq "elementCount 3 (Wall A, Wall B, Slab S)" "3" "$(j "$MESH2" '.data.mesh.elementCount')"
assert_eq "vertexCount 24 (3 × 8)" "24" "$(j "$MESH2" '.data.mesh.vertexCount')"
assert_eq "triangleCount 36 (3 × 12)" "36" "$(j "$MESH2" '.data.mesh.triangleCount')"
assert_eq "mesh name is the pinned derived name" "two-elements.ifc — 3D mesh" "$(j "$MESH2" '.data.mesh.name')"
assert_eq "engine ifcopenshell 0.9.0.post1 via ifc_mesh.py" \
  "ifcopenshell|0.9.0.post1|ifc_mesh.py" "$(j "$MESH2" '.data.mesh.engineKey')|$(j "$MESH2" '.data.mesh.engineVersion')|$(j "$MESH2" '.data.mesh.adapterScript')"

http GET "/api/artifacts/$MESH2_ID/mesh"
MESH2_GET="$BODY"
assert_eq "stored mesh elements carry the authored names + IFC GlobalId refs" \
  "Wall A,Wall B,Slab S|#3rUnE8CnPHBwLdZzIqZkf1,#3rUnE8CnPHBwLdZzIqZkf2,#3rUnE8CnPHBwLdZzIqZkf3" \
  "$(j "$MESH2_GET" '[.data.mesh.elements[].name] | join(",")')|$(j "$MESH2_GET" '[.data.mesh.elements[].elementRef] | sort | join(",")')"

MESH_REFS=$(j "$MESH2_GET" '[.data.mesh.elements[].elementRef] | unique | sort | join(",")')
QTY_REFS=$(j "$ELEM_Q" '[.data.quantities[].elementRef] | unique | sort | join(",")')
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "CROSS-REFERENCE CONTRACT: mesh elementRefs SET-EQUAL the unique model-derived quantity rows' refs on the same fixture (+ ifc mesh audit actor)" \
  "equal|equal|adapter:ifcopenshell" \
  "$( [[ "$MESH_REFS" == "$QTY_REFS" ]] && echo equal || echo "mesh=$MESH_REFS qty=$QTY_REFS")|$( [[ "$QTY_REFS" == "#3rUnE8CnPHBwLdZzIqZkf1,#3rUnE8CnPHBwLdZzIqZkf2,#3rUnE8CnPHBwLdZzIqZkf3" ]] && echo equal || echo "$QTY_REFS")|$(j "$BODY" "[.data.events[] | select(.action == \"mesh.derived\" and .entityId == \"$MESH2_ID\")][0].actorId")"

# ===========================================================================
# 30-33. AC-P2-03 re-derive appends a revision; byte-determinism end-to-end
# ===========================================================================
http POST "/api/projects/$PROBE_ID/artifacts/$SOLIDS_ID/derive-mesh"
MESH3="$BODY"
assert_eq "re-derive appends to the SAME mesh artifact (never a new one)" "$MESH_ID" "$(j "$MESH3" '.data.mesh.artifactId')"
assert_eq "re-derive appends revision 2" "2" "$(j "$MESH3" '.data.mesh.revisionNumber')"
assert_eq "byte-determinism: revision 2 contentHash IDENTICAL to revision 1 (timestamp-free adapter payloads)" \
  "$MESH1_HASH" "$(j "$MESH3" '.data.mesh.contentHash')"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly two mesh.derived audit events on the two-solids mesh artifact now" \
  "2" "$(j "$BODY" "[.data.events[] | select(.action == \"mesh.derived\" and .entityId == \"$MESH_ID\")] | length")"

# ===========================================================================
# 34-43. AC-P2-04 staleness cascade (Journey-G reuse) + regenerate clears it
# ===========================================================================
upload "/api/artifacts/$SOLIDS_ID/revisions" "$FIXTURES/two-solids.step" model ""
REV_POST="$BODY"
NEW_SOURCE_REV=$(j "$REV_POST" '.data.revision.id')
assert_eq "new SOURCE revision via the real revisions route → 201, rev 2, exactly one downstream marked" \
  "201|2|1" "$STATUS|$(j "$REV_POST" '.data.revision.revNumber')|$(j "$REV_POST" '.data.staleMarked | length')"
assert_eq "staleMarked path evidence: [source, mesh] via derived_from" \
  "derived_from|$SOLIDS_ID,$MESH_ID" \
  "$(j "$REV_POST" '.data.staleMarked[0].relation')|$(j "$REV_POST" '.data.staleMarked[0].path | join(",")')"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "artifact.staled audit event with path evidence [source, mesh]" \
  "$SOLIDS_ID,$MESH_ID|$SOLIDS_ID" \
  "$(j "$BODY" '[.data.events[] | select(.action == "artifact.staled")][0].detail | fromjson | .path | join(",")')|$(j "$BODY" '[.data.events[] | select(.action == "artifact.staled")][0].detail | fromjson | .because')"

http GET "/api/artifacts/$MESH_ID/mesh"
STALE_GET="$BODY"
assert_eq "GET mesh reports staleSource true after the source revision" "true" "$(j "$STALE_GET" '.data.meta.staleSource')"
assert_eq "GET mesh reports staleness \"stale\" (cascade marked the revision)" "stale" "$(j "$STALE_GET" '.data.meta.staleness')"
assert_eq "meta.derivedFromRevisionId still records the OLD source revision (rev 1)" "$SOLIDS_REV1" "$(j "$STALE_GET" '.data.meta.derivedFromRevisionId')"
assert_eq "meta.sourceLatestRevisionId now points at the NEW source revision" "$NEW_SOURCE_REV" "$(j "$STALE_GET" '.data.meta.sourceLatestRevisionId')"

http POST "/api/projects/$PROBE_ID/artifacts/$SOLIDS_ID/derive-mesh"
MESH4="$BODY"
assert_eq "Regenerate → revision 3 + staleSource false" "201|3|false" "$STATUS|$(j "$MESH4" '.data.mesh.revisionNumber')|$(j "$MESH4" '.data.mesh.staleSource')"
assert_eq "regenerated mesh derivedFromRevisionId == the NEW source latest revision" "$NEW_SOURCE_REV" "$(j "$MESH4" '.data.mesh.derivedFromRevisionId')"
http GET "/api/artifacts/$MESH_ID/mesh"
assert_eq "GET mesh after regenerate: staleness current, staleSource false" \
  "current|false" "$(j "$BODY" '.data.meta.staleness')|$(j "$BODY" '.data.meta.staleSource')"

# ===========================================================================
# 44-53. AC-P2-05 honest error gates with VERBATIM messages; zero side effects
# ===========================================================================
http GET "/api/events?projectId=$PROBE_ID&limit=200"
EVENTS_BEFORE_MESH=$(j "$BODY" '[.data.events[] | select(.action == "mesh.derived")] | length')
EVENTS_BEFORE_QTY=$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived")] | length')

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/site-notes.md" document "site-notes.md"
NOTES_ID=$(j "$BODY" '.data.artifact.id')
NOTES_KEY=$(j "$BODY" '.data.artifact.latestRevision.storageKey')
assert_eq "site-notes.md registered (201, kind document — non-derivable by extension)" \
  "201|document" "$STATUS|$(j "$BODY" '.data.artifact.kind')"

http POST "/api/projects/$PROBE_ID/artifacts/$NOTES_ID/derive-mesh"
UNSUPPORTED_MSG="artifact \"site-notes.md\" (storage key $NOTES_KEY) does not carry a derivable model extension (.step/.stp/.ifc)"
assert_eq "non-derivable artifact → 422 unsupported VERBATIM (byte-identical to the quantities route)" \
  "422|unsupported|$UNSUPPORTED_MSG" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

http POST "/api/projects/$PROBE_ID/artifacts/$NOTES_ID/derive-quantities"
assert_eq "derive-quantities on the same artifact → the SAME byte-identical refusal" \
  "$UNSUPPORTED_MSG" "$(j "$BODY" '.error.message')"

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/bracket.step" model "bracket.step"
BRACKET_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "bracket.step registered (201, kind model, geometry-free)" "201|model" "$STATUS|$(j "$BODY" '.data.artifact.kind')"

http POST "/api/projects/$PROBE_ID/artifacts/$BRACKET_ID/derive-mesh"
assert_eq "geometry-free STEP → 422 engine_unavailable VERBATIM (never an empty mesh)" \
  "422|engine_unavailable|no solid geometry found in STEP file (import produced 0 solids) - cannot tessellate, and simulated meshes are not an option" \
  "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

http POST "/api/projects/prj_does-not-exist/artifacts/$SOLIDS_ID/derive-mesh"
assert_eq "unknown project → 404 verbatim" "404|Project not found" "$STATUS|$(j "$BODY" '.error.message')"

http POST "/api/projects/$PROBE_ID/artifacts/art_does-not-exist/derive-mesh"
assert_eq "unknown artifact → 404 verbatim" "404|Artifact not found" "$STATUS|$(j "$BODY" '.error.message')"

http GET "/api/artifacts/$NOTES_ID/mesh"
assert_eq "GET mesh on a non-mesh artifact → 422 VERBATIM" \
  "422|artifact \"site-notes.md\" is not a mesh (kind \"document\")" "$STATUS|$(j "$BODY" '.error.message')"

http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "failed derives wrote ZERO extra mesh.derived audit events" \
  "$EVENTS_BEFORE_MESH" "$(j "$BODY" '[.data.events[] | select(.action == "mesh.derived")] | length')"
assert_eq "failed derives wrote ZERO extra quantity.derived audit events" \
  "$EVENTS_BEFORE_QTY" "$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived")] | length')"

# ===========================================================================
# 54-64. AC-P2-06 GET /api/artifacts/[id]/mesh serves the pinned eos-mesh/1
# ===========================================================================
http GET "/api/artifacts/$MESH_ID/mesh"
MESH_GET="$BODY"
MESH4_HASH=$(j "$MESH4" '.data.mesh.contentHash')
assert_eq "stored payload is eos-mesh/1: units m, upAxis z, tolerance 0.0001 (vertices in metres, axis declared — never rewritten)" \
  "eos-mesh/1|m|z|0.0001" \
  "$(j "$MESH_GET" '.data.mesh.format')|$(j "$MESH_GET" '.data.mesh.units')|$(j "$MESH_GET" '.data.mesh.upAxis')|$(j "$MESH_GET" '.data.mesh.tolerance')"
assert_eq "generatedBy provenance block (cadquery 2.6.1 via step_mesh.py, 64-hex adapterHash)" \
  "cadquery|2.6.1|step_mesh.py|true" \
  "$(j "$MESH_GET" '.data.mesh.generatedBy.engineKey')|$(j "$MESH_GET" '.data.mesh.generatedBy.engineVersion')|$(j "$MESH_GET" '.data.mesh.generatedBy.adapterScript')|$(j "$MESH_GET" '.data.mesh.generatedBy.adapterHash | test("^[0-9a-f]{64}$")')"
assert_eq "meta: artifactId + pinned name + revisionNumber 3 (post-regenerate latest)" \
  "$MESH_ID|two-solids.step — 3D mesh|3" \
  "$(j "$MESH_GET" '.data.meta.artifactId')|$(j "$MESH_GET" '.data.meta.name')|$(j "$MESH_GET" '.data.meta.revisionNumber')"
assert_eq "meta: contentHash == the rev-3 derive hash + non-zero sizeBytes" \
  "$MESH4_HASH|true" "$(j "$MESH_GET" '.data.meta.contentHash')|$( [[ "$(j "$MESH_GET" '.data.meta.sizeBytes')" -gt 0 ]] && echo true || echo false)"
assert_eq "meta: fresh state (staleSource false, staleness current)" "false|current" \
  "$(j "$MESH_GET" '.data.meta.staleSource')|$(j "$MESH_GET" '.data.meta.staleness')"
assert_eq "meta: derivedFrom/sourceLatest join (artifact + NEW revision) + sourceArtifactName" \
  "$SOLIDS_ID|$NEW_SOURCE_REV|$NEW_SOURCE_REV|two-solids.step" \
  "$(j "$MESH_GET" '.data.meta.derivedFromArtifactId')|$(j "$MESH_GET" '.data.meta.derivedFromRevisionId')|$(j "$MESH_GET" '.data.meta.sourceLatestRevisionId')|$(j "$MESH_GET" '.data.meta.sourceArtifactName')"
assert_eq "meta: engine/adapter fields from generatedBy + generatedAt is an ISO timestamp" \
  "cadquery|2.6.1|step_mesh.py|iso" \
  "$(j "$MESH_GET" '.data.meta.engineKey')|$(j "$MESH_GET" '.data.meta.engineVersion')|$(j "$MESH_GET" '.data.meta.adapterScript')|$( [[ "$(j "$MESH_GET" '.data.meta.generatedAt')" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] && echo iso || echo "$(j "$MESH_GET" '.data.meta.generatedAt')")"
assert_eq "elements: Solid 1 / Solid 2 with refs step:solid:0 / step:solid:1" \
  "Solid 1,Solid 2|step:solid:0,step:solid:1" \
  "$(j "$MESH_GET" '[.data.mesh.elements[].name] | join(",")')|$(j "$MESH_GET" '[.data.mesh.elements[].elementRef] | join(",")')"
assert_eq "per-element topology: 24 vertices / 12 triangles each (OCCT per-face duplicated vertices, documented)" \
  "24|12|24|12" \
  "$(j "$MESH_GET" '.data.mesh.elements[0].vertices | length')|$(j "$MESH_GET" '.data.mesh.elements[0].triangles | length')|$(j "$MESH_GET" '.data.mesh.elements[1].vertices | length')|$(j "$MESH_GET" '.data.mesh.elements[1].triangles | length')"

GEOM_OK=$(python3 -c 'import sys, json
m = json.loads(sys.argv[1])["data"]["mesh"]
for el in m["elements"]:
    nv = len(el["vertices"])
    for tri in el["triangles"]:
        if len(tri) != 3 or any((not isinstance(i, int)) or i < 0 or i >= nv for i in tri):
            sys.exit(1)
sys.exit(0)' "$MESH_GET" && echo ok || echo bad)
assert_eq "all triangle indices are in range (< per-element vertexCount)" "ok" "$GEOM_OK"

METERS_OK=$(python3 -c 'import sys, json
m = json.loads(sys.argv[1])["data"]["mesh"]
peak = max(abs(c) for el in m["elements"] for v in el["vertices"] for c in v)
sys.exit(0 if 0 < peak < 1 else 1)' "$MESH_GET" && echo ok || echo bad)
assert_eq "vertices are in METRES (30/15 mm boxes → all |coords| < 1 m; mm would peak at 115)" "ok" "$METERS_OK"

# ===========================================================================
# 65-67. AC-P2-07 tessellation adapters harness-validated (registry evidence)
# ===========================================================================
http GET /api/engines
assert_eq "/api/engines serves .data.registry with both tessellation engines" \
  "true|true|true" \
  "$(j "$BODY" '.data.registry | type == "array"')|$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")] | length == 1')|$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")] | length == 1')"
assert_eq "cadquery entry: state tested + validation {harness, cases 5, lastRun, result pass} + mesh blocks (4 cases, pass)" \
  "tested|tests/validation/corpus-manifest.json|5|pass|4|pass" \
  "$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")][0].state')|$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")][0].validation.harness')|$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")][0].validation.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")][0].validation.result')|$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")][0].validation.mesh.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "cadquery")][0].validation.mesh.result')"
assert_eq "ifcopenshell entry: state tested + validation {harness, cases 6, lastRun, result pass} + mesh blocks (5 cases, pass)" \
  "tested|tests/validation/corpus-manifest.json|6|pass|5|pass" \
  "$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")][0].state')|$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")][0].validation.harness')|$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")][0].validation.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")][0].validation.result')|$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")][0].validation.mesh.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "ifcopenshell")][0].validation.mesh.result')"

echo
echo "== e2e-p2-modelviewer.sh: $PASS PASS / $FAIL FAIL =="
if [[ "$FAIL" -ne 0 ]]; then
  echo "probe project $PROBE_ID KEPT for forensics"
  exit 1
fi
cd "$HERE/.." && bun scripts/dev-db-cleanup.ts --project "$PROBE_ID" >/dev/null
echo "probe project removed — dev DB is the demo dataset only"
