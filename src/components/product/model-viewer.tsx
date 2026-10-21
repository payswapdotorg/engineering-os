"use client"

/**
 * Design Studio — 3D model viewport (W1-d lane, Phase 2).
 *
 * Loaded ONLY via next/dynamic with `ssr: false` from studio-workspace.tsx
 * (a client component), so three.js never touches the server bundle — do NOT
 * import this module statically anywhere, or the whole 3D stack lands in the
 * initial chunk. The stored eos-mesh/1 payload is rendered VERBATIM:
 * vertices in meters, source up-axis preserved. The up-axis is a VIEWER
 * concern here — z-up sources are rotated −90° about X onto three.js' y-up;
 * the mesh file itself is never rewritten.
 *
 * Honesty rules this component follows:
 *  - the palette is deterministic (caller-supplied colorOf: element index →
 *    color) and NOT blue/indigo-dominant (repo-wide design rule);
 *  - the elementRefs are exactly the quantity-ledger refs, so what you pick
 *    here cross-references takeoff rows;
 *  - the initial camera framing is fit-to-view, computed from the actual
 *    vertex bounds — no canned camera distance.
 */
import { OrbitControls, PerspectiveCamera } from "@react-three/drei"
import { Canvas, type ThreeEvent } from "@react-three/fiber"
import { useEffect, useMemo, useState } from "react"
import * as THREE from "three"

import type { MeshElementRow, MeshPayloadRow } from "@/components/product/api"

/** Click highlight — kept outside the caller's palette so it can never collide. */
const PICK_COLOR = "#ea580c" // orange-600

const FRAME_FOV = 50

/**
 * Resolve any CSS color string to raw RGB via a 1×1 canvas fill — the browser
 * parses every modern format (rgb(), lab(), oklch(), …) for canvas fills, so
 * this never depends on THREE.Color's narrower parser (which warns on lab()).
 * Returns null when the string cannot be parsed; callers keep their fallback.
 */
function cssColorToRgb(css: string): [number, number, number] | null {
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.fillStyle = "#000000"
    ctx.fillStyle = css
    if (ctx.fillStyle !== css.toLowerCase() && ctx.fillStyle === "#000000") return null
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    if (d[3] === 0) return null // fully transparent — no usable stage color
    return [d[0] / 255, d[1] / 255, d[2] / 255]
  } catch {
    return null
  }
}

/**
 * Opaque stage color for the viewport = the theme's page background (read from
 * the live computed style, re-read on theme flips). A defined stage reads as a
 * CAD pane in both light and dark themes and removes any dependence on
 * alpha-compositing behavior of the host (which headless browsers can mangle).
 */
function useStageBackground(): [number, number, number] {
  const [rgb, setRgb] = useState<[number, number, number]>([0.9607, 0.9607, 0.9568])
  useEffect(() => {
    const read = () => {
      try {
        const css = getComputedStyle(document.body).backgroundColor
        const parsed = cssColorToRgb(css)
        if (parsed) setRgb(parsed)
      } catch {
        // keep the fallback — never render a broken stage over an honest one
      }
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    return () => observer.disconnect()
  }, [])
  return rgb
}

interface Framing {
  center: [number, number, number]
  distance: number
  near: number
  far: number
  position: [number, number, number]
}

/**
 * Fit-to-view framing from the real vertex bounds (after the z-up rotation the
 * group applies, so the camera and the geometry agree). Deterministic: same
 * mesh → same framing.
 */
function frameMesh(mesh: MeshPayloadRow): Framing {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let points = 0

  for (const element of mesh.elements) {
    for (const v of element.vertices) {
      // Same transform the group applies: z-up → y-up is (x, y, z) → (x, z, −y).
      const x = v[0]
      const y = mesh.upAxis === "z" ? v[2] : v[1]
      const z = mesh.upAxis === "z" ? -v[1] : v[2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
      points += 1
    }
  }

  if (points === 0) {
    return {
      center: [0, 0, 0],
      distance: 2,
      near: 0.01,
      far: 100,
      position: [1.4, 0.8, 1.8],
    }
  }

  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ]
  const radius =
    Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2 ||
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 ||
    0.5
  const distance = (radius / Math.tan(((FRAME_FOV / 2) * Math.PI) / 180)) * 1.4
  const dir = new THREE.Vector3(1, 0.55, 1.3).normalize()
  return {
    center,
    distance,
    near: Math.max((distance - radius) / 50, 0.001),
    far: (distance + radius) * 20,
    position: [
      center[0] + dir.x * distance,
      center[1] + dir.y * distance,
      center[2] + dir.z * distance,
    ],
  }
}

function ElementMesh({
  element,
  color,
  picked,
  hovered,
  onHover,
  onPick,
}: {
  element: MeshElementRow
  color: string
  picked: boolean
  hovered: boolean
  onHover: (elementRef: string | null) => void
  onPick: (elementRef: string) => void
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const positions = new Float32Array(element.vertices.length * 3)
    for (let i = 0; i < element.vertices.length; i += 1) {
      const v = element.vertices[i]
      positions[i * 3] = v[0]
      positions[i * 3 + 1] = v[1]
      positions[i * 3 + 2] = v[2]
    }
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3))
    if (element.triangles.length > 0) {
      const indices = new Uint32Array(element.triangles.length * 3)
      for (let i = 0; i < element.triangles.length; i += 1) {
        const t = element.triangles[i]
        indices[i * 3] = t[0]
        indices[i * 3 + 1] = t[1]
        indices[i * 3 + 2] = t[2]
      }
      g.setIndex(new THREE.BufferAttribute(indices, 1))
    }
    g.computeVertexNormals()
    return g
  }, [element])

  // GPU-side geometry is not GC'd — dispose on swap/unmount.
  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  const handleOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover(element.elementRef)
  }
  const handleOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover(null)
  }
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    onPick(element.elementRef)
  }

  return (
    <mesh
      geometry={geometry}
      onPointerOver={handleOver}
      onPointerOut={handleOut}
      onClick={handleClick}
    >
      <meshStandardMaterial
        color={picked ? PICK_COLOR : color}
        emissive={hovered && !picked ? color : "#000000"}
        emissiveIntensity={hovered && !picked ? 0.45 : 0}
        flatShading
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

export function ModelViewer({
  mesh,
  pickedElementRef,
  onPickElement,
  colorOf,
}: {
  mesh: MeshPayloadRow
  pickedElementRef: string | null
  onPickElement: (elementRef: string | null) => void
  /** deterministic element color by index (owned by the parent workspace) */
  colorOf: (index: number) => string
}) {
  const [hoveredRef, setHoveredRef] = useState<string | null>(null)
  const framing = useMemo(() => frameMesh(mesh), [mesh])
  const stage = useStageBackground()

  // Pointer affordance for hoverable elements (restore on change/unmount).
  useEffect(() => {
    if (!hoveredRef) return
    const previous = document.body.style.cursor
    document.body.style.cursor = "pointer"
    return () => {
      document.body.style.cursor = previous
    }
  }, [hoveredRef])

  return (
    <Canvas
      className="h-full w-full"
      role="img"
      aria-label={`Interactive 3D view — ${mesh.elements.length} element${mesh.elements.length === 1 ? "" : "s"}, drag to orbit, scroll to zoom`}
      onPointerMissed={() => onPickElement(null)}
      gl={{ antialias: true, alpha: true }}
    >
      {/* Fit-to-view camera — declarative (drei). The key remounts it when the
          framing changes (regenerate/new mesh) so fov/near/far always match
          the current vertex bounds. */}
      <PerspectiveCamera
        key={`${framing.center.join(",")}:${framing.distance}`}
        makeDefault
        position={framing.position}
        near={framing.near}
        far={framing.far}
        fov={FRAME_FOV}
      />
      <color attach="background" args={stage} />
      <ambientLight intensity={0.9} />
      <directionalLight
        position={[
          framing.center[0] + framing.distance,
          framing.center[1] + framing.distance * 0.8,
          framing.center[2] + framing.distance,
        ]}
        intensity={1.6}
      />
      <directionalLight
        position={[
          framing.center[0] - framing.distance,
          framing.center[1] + framing.distance * 0.5,
          framing.center[2] - framing.distance,
        ]}
        intensity={0.45}
      />
      <group rotation={mesh.upAxis === "z" ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}>
        {mesh.elements.map((element, i) => (
          <ElementMesh
            key={element.elementRef}
            element={element}
            color={colorOf(i)}
            picked={pickedElementRef === element.elementRef}
            hovered={hoveredRef === element.elementRef}
            onHover={setHoveredRef}
            onPick={onPickElement}
          />
        ))}
      </group>
      <OrbitControls target={framing.center} makeDefault />
    </Canvas>
  )
}

export default ModelViewer
