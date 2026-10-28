import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { COLORMAP_INDEX, MODE_INDEX, QUALITY_STEPS } from '@/lib/presets'
import type { PerfStats, ViewerSettings, Volume } from '@/lib/types'
import { volumeFragmentShader, volumeVertexShader } from './shaders'

export type CameraView = 'anterior' | 'posterior' | 'left' | 'right' | 'superior' | 'inferior'

const VIEW_DIRECTIONS: Record<CameraView, THREE.Vector3> = {
  anterior: new THREE.Vector3(0, 0, 1),
  posterior: new THREE.Vector3(0, 0, -1),
  // Patient left is +x in world space, so a left lateral view looks from +x.
  left: new THREE.Vector3(1, 0, 0),
  right: new THREE.Vector3(-1, 0, 0),
  superior: new THREE.Vector3(0, 1, 0.0001),
  inferior: new THREE.Vector3(0, -1, 0.0001),
}

const CAMERA_DISTANCE = 2.4
const STATS_INTERVAL_MS = 250
/** After the last camera/setting change, wait this long before the full-quality refine pass. */
const IDLE_DELAY_MS = 220
/** Ray-march step reduction while interacting. */
const INTERACTIVE_STEP_FACTOR = 0.6
/** Dynamic-resolution controller: frame budget (ms) and bounds on the render scale. */
const TARGET_FRAME_MS = 19
const MIN_SCALE = 0.3
const SCALE_QUANTUM = 0.05

interface GpuTimer {
  ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
  gl: WebGL2RenderingContext
  pending: WebGLQuery[]
}

type FrameKind = 'interactive' | 'full'

export class VolumeRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly material: THREE.ShaderMaterial
  private readonly mesh: THREE.Mesh
  private readonly outline: THREE.LineSegments
  private readonly resizeObserver: ResizeObserver
  private readonly gpuTimer: GpuTimer | null
  private readonly cameraLocal = new THREE.Vector3()
  private readonly container: HTMLElement
  private readonly onStats: (stats: PerfStats) => void
  private readonly basePixelRatio = Math.min(window.devicePixelRatio, 2)
  private texture: THREE.Data3DTexture | null = null
  private volume: Volume | null = null

  private baseSteps = QUALITY_STEPS.balanced
  private adaptive = true
  private dirty = true
  private dragging = false
  private lastActivity = 0
  private lastKind: FrameKind = 'full'
  /** Learned interactive resolution scale, kept across interactions. */
  private scale = 1
  private appliedPixelRatio = 0
  private lastInteractiveAt = 0
  private frameCostEma: number | null = null

  private frames = 0
  private frameTimeAcc = 0
  private frameTimeSamples = 0
  private cpuTimeAcc = 0
  private lastStats = performance.now()
  private gpuMs: number | null = null
  private lastFullCpuMs = 0

  constructor(container: HTMLElement, onStats: (stats: PerfStats) => void) {
    this.container = container
    this.onStats = onStats
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.domElement.className = 'block h-full w-full touch-none outline-none'
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50)
    this.camera.position.set(0, 0, CAMERA_DISTANCE)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.minDistance = 0.4
    this.controls.maxDistance = 8
    this.controls.addEventListener('start', () => {
      this.dragging = true
      this.touch()
    })
    this.controls.addEventListener('end', () => {
      this.dragging = false
      this.touch()
    })
    this.controls.addEventListener('change', () => this.touch())

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: volumeVertexShader,
      fragmentShader: volumeFragmentShader,
      side: THREE.BackSide,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      uniforms: {
        uVolume: { value: null },
        uDims: { value: new THREE.Vector3(1, 1, 1) },
        uScale: { value: new THREE.Vector3(1, 1, 1) },
        uCameraLocal: { value: new THREE.Vector3() },
        uClipMin: { value: new THREE.Vector3(0, 0, 0) },
        uClipMax: { value: new THREE.Vector3(1, 1, 1) },
        uWindow: { value: new THREE.Vector2(0, 1) },
        uThreshold: { value: new THREE.Vector2(0, 1) },
        uOpacity: { value: 0.5 },
        uBrightness: { value: 1 },
        uSteps: { value: this.baseSteps },
        uMode: { value: 0 },
        uColormap: { value: 0 },
        uShading: { value: true },
      },
    })

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material)
    // Volume axes are (column → patient left, row → posterior, slice → superior).
    // Rotate so superior points up (+Y) and anterior faces the default camera (+Z).
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.visible = false
    this.scene.add(this.mesh)

    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0.18 }),
    )
    this.mesh.add(this.outline)

    this.gpuTimer = this.createGpuTimer()
    this.applyPixelRatio(1)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.renderer.setAnimationLoop(this.frame)
  }

  get maxTextureSize(): number {
    const gl = this.renderer.getContext() as WebGL2RenderingContext
    return (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number | null) ?? 2048
  }

  setVolume(volume: Volume): number {
    const t0 = performance.now()
    const [nx, ny, nz] = volume.dims
    const limit = this.maxTextureSize
    if (nx > limit || ny > limit || nz > limit) {
      throw new Error(`Volume ${nx}×${ny}×${nz} exceeds this GPU's 3D texture limit (${limit})`)
    }

    this.texture?.dispose()
    const texture = new THREE.Data3DTexture(volume.gpuData, nx, ny, nz)
    texture.format = THREE.RedFormat
    texture.type = THREE.HalfFloatType
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping
    texture.unpackAlignment = 1
    texture.needsUpdate = true
    this.texture = texture
    this.volume = volume

    const [sx, sy, sz] = volume.spacing
    const extent = new THREE.Vector3(nx * sx, ny * sy, nz * sz)
    const maxExtent = Math.max(extent.x, extent.y, extent.z)
    const scale = extent.divideScalar(maxExtent)
    this.mesh.scale.copy(scale)
    this.material.uniforms.uVolume.value = texture
    this.material.uniforms.uDims.value.set(nx, ny, nz)
    this.material.uniforms.uScale.value.copy(scale)
    this.mesh.visible = true

    // Force the upload now so the caller can report the cost.
    this.renderer.initTexture(texture)
    this.setView('anterior')
    this.dirty = true
    this.lastActivity = 0
    return performance.now() - t0
  }

  setSettings(s: ViewerSettings): void {
    const v = this.volume
    if (!v) return
    const range = v.valueMax - v.valueMin
    const norm = (hu: number) => (hu - v.valueMin) / range
    const u = this.material.uniforms
    u.uWindow.value.set(norm(s.windowCenter - s.windowWidth / 2), norm(s.windowCenter + s.windowWidth / 2))
    u.uThreshold.value.set(norm(s.threshold[0]), norm(s.threshold[1]))
    u.uOpacity.value = s.opacity
    u.uBrightness.value = s.brightness
    u.uMode.value = MODE_INDEX[s.mode]
    u.uColormap.value = COLORMAP_INDEX[s.colormap]
    u.uShading.value = s.shading
    u.uClipMin.value.set(s.clipX[0], s.clipY[0], s.clipZ[0])
    u.uClipMax.value.set(s.clipX[1], s.clipY[1], s.clipZ[1])
    this.baseSteps = QUALITY_STEPS[s.quality]
    this.adaptive = s.adaptive
    // Slider drags behave like camera drags: cheap previews, then a refine pass.
    this.touch()
  }

  setView(view: CameraView): void {
    const dir = VIEW_DIRECTIONS[view].clone().normalize()
    this.controls.target.set(0, 0, 0)
    this.camera.position.copy(dir.multiplyScalar(CAMERA_DISTANCE))
    this.camera.up.set(0, 1, 0)
    if (view === 'superior') this.camera.up.set(0, 0, -1)
    if (view === 'inferior') this.camera.up.set(0, 0, 1)
    this.camera.lookAt(0, 0, 0)
    this.controls.update()
    this.dirty = true
  }

  screenshot(): string {
    this.draw('full')
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.texture?.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
    this.outline.geometry.dispose()
    ;(this.outline.material as THREE.Material).dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private touch() {
    this.dirty = true
    this.lastActivity = performance.now()
  }

  private applyPixelRatio(scale: number) {
    const ratio = this.basePixelRatio * scale
    if (Math.abs(ratio - this.appliedPixelRatio) < 1e-3) return
    this.appliedPixelRatio = ratio
    this.renderer.setPixelRatio(ratio)
    const { clientWidth: w, clientHeight: h } = this.container
    if (w > 0 && h > 0) this.renderer.setSize(w, h, false)
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  /** Nudges the interactive resolution towards the frame budget. */
  private adaptScale(frameMs: number) {
    this.frameCostEma = this.frameCostEma === null ? frameMs : this.frameCostEma * 0.7 + frameMs * 0.3
    let next = this.scale
    if (this.frameCostEma > TARGET_FRAME_MS * 1.25) next = this.scale * 0.85
    else if (this.frameCostEma < TARGET_FRAME_MS) next = this.scale * 1.08
    next = Math.min(1, Math.max(MIN_SCALE, Math.round(next / SCALE_QUANTUM) * SCALE_QUANTUM))
    if (next !== this.scale) {
      this.scale = next
      this.frameCostEma = null
    }
  }

  private createGpuTimer(): GpuTimer | null {
    const gl = this.renderer.getContext()
    if (!(gl instanceof WebGL2RenderingContext)) return null
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimer['ext'] | null
    return ext ? { ext, gl, pending: [] } : null
  }

  private pollGpuTimer() {
    const t = this.gpuTimer
    if (!t) return
    const disjoint = t.gl.getParameter(t.ext.GPU_DISJOINT_EXT) as boolean
    while (t.pending.length) {
      const q = t.pending[0]
      if (!t.gl.getQueryParameter(q, t.gl.QUERY_RESULT_AVAILABLE)) break
      t.pending.shift()
      if (!disjoint) {
        const ms = (t.gl.getQueryParameter(q, t.gl.QUERY_RESULT) as number) / 1e6
        this.gpuMs = this.gpuMs === null ? ms : this.gpuMs * 0.7 + ms * 0.3
      }
      t.gl.deleteQuery(q)
    }
  }

  private draw(kind: FrameKind): number {
    const interactive = kind === 'interactive'
    this.applyPixelRatio(interactive ? this.scale : 1)
    const steps = interactive ? this.baseSteps * INTERACTIVE_STEP_FACTOR : this.baseSteps
    this.material.uniforms.uSteps.value = Math.max(64, Math.round(steps))

    if (this.mesh.visible) {
      this.mesh.updateMatrixWorld()
      this.cameraLocal.copy(this.camera.position)
      this.mesh.worldToLocal(this.cameraLocal)
      this.material.uniforms.uCameraLocal.value.copy(this.cameraLocal)
    }

    const t = this.gpuTimer
    let query: WebGLQuery | null = null
    if (t && t.pending.length < 4) {
      query = t.gl.createQuery()
      if (query) t.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, query)
    }
    const c0 = performance.now()
    this.renderer.render(this.scene, this.camera)
    const cpu = performance.now() - c0
    if (t && query) {
      t.gl.endQuery(t.ext.TIME_ELAPSED_EXT)
      t.pending.push(query)
    }
    this.lastKind = kind
    this.dirty = false
    return cpu
  }

  private frame = () => {
    const now = performance.now()
    this.controls.update()
    this.pollGpuTimer()

    const active = this.dragging || now - this.lastActivity < IDLE_DELAY_MS
    let kind: FrameKind | null = null
    if (!this.adaptive) kind = 'full'
    else if (active && this.dirty) kind = 'interactive'
    else if (!active && (this.dirty || this.lastKind === 'interactive')) kind = 'full'

    if (kind) {
      const prevInteractive = this.lastInteractiveAt
      const cpu = this.draw(kind)
      this.cpuTimeAcc += cpu
      this.frames++
      if (kind === 'full') this.lastFullCpuMs = cpu
      const consecutive = !this.adaptive || kind === 'interactive'
      if (consecutive && prevInteractive > 0 && now - prevInteractive < 1000) {
        const delta = now - prevInteractive
        this.frameTimeAcc += delta
        this.frameTimeSamples++
        if (kind === 'interactive') this.adaptScale(Math.max(delta, cpu, this.gpuMs ?? 0))
      }
      this.lastInteractiveAt = consecutive ? now : 0
    }

    if (now - this.lastStats >= STATS_INTERVAL_MS) {
      const elapsed = now - this.lastStats
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      const mode: PerfStats['mode'] = !this.adaptive ? 'continuous' : this.frames > 0 && active ? 'interactive' : 'idle'
      this.onStats({
        mode,
        fps: (this.frames * 1000) / elapsed,
        frameMs: this.frameTimeSamples ? this.frameTimeAcc / this.frameTimeSamples : null,
        cpuMs: this.frames ? this.cpuTimeAcc / this.frames : this.lastFullCpuMs,
        gpuMs: this.gpuMs,
        drawingBuffer: [size.x, size.y],
        resolutionScale: this.lastKind === 'interactive' ? this.scale : 1,
        steps: this.material.uniforms.uSteps.value as number,
      })
      this.frames = 0
      this.frameTimeAcc = 0
      this.frameTimeSamples = 0
      this.cpuTimeAcc = 0
      this.lastStats = now
    }
  }
}
