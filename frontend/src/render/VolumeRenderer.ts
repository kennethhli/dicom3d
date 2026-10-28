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
/** Ray-march step reduction while the user is dragging. */
const INTERACTIVE_STEP_FACTOR = 0.5

interface GpuTimer {
  ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
  gl: WebGL2RenderingContext
  pending: WebGLQuery[]
}

export class VolumeRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly material: THREE.ShaderMaterial
  private readonly mesh: THREE.Mesh
  private readonly outline: THREE.LineSegments
  private readonly resizeObserver: ResizeObserver
  private texture: THREE.Data3DTexture | null = null
  private volume: Volume | null = null
  private baseSteps = QUALITY_STEPS.balanced
  private interacting = false
  private interactionTimer: number | undefined
  private readonly gpuTimer: GpuTimer | null
  private readonly cameraLocal = new THREE.Vector3()

  private frames = 0
  private frameTimeAcc = 0
  private cpuTimeAcc = 0
  private lastFrame = performance.now()
  private lastStats = performance.now()
  private gpuMs: number | null = null

  private readonly container: HTMLElement
  private readonly onStats: (stats: PerfStats) => void

  constructor(container: HTMLElement, onStats: (stats: PerfStats) => void) {
    this.container = container
    this.onStats = onStats
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
    this.controls.addEventListener('start', this.onInteractStart)
    this.controls.addEventListener('end', this.onInteractEnd)

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
    this.updateSteps()
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
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null)
    window.clearTimeout(this.interactionTimer)
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

  private onInteractStart = () => {
    window.clearTimeout(this.interactionTimer)
    this.interacting = true
    this.updateSteps()
  }

  private onInteractEnd = () => {
    window.clearTimeout(this.interactionTimer)
    this.interactionTimer = window.setTimeout(() => {
      this.interacting = false
      this.updateSteps()
    }, 180)
  }

  private updateSteps() {
    const steps = this.interacting ? this.baseSteps * INTERACTIVE_STEP_FACTOR : this.baseSteps
    this.material.uniforms.uSteps.value = Math.max(64, Math.round(steps))
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
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
        const ns = t.gl.getQueryParameter(q, t.gl.QUERY_RESULT) as number
        this.gpuMs = this.gpuMs === null ? ns / 1e6 : this.gpuMs * 0.8 + (ns / 1e6) * 0.2
      }
      t.gl.deleteQuery(q)
    }
  }

  private frame = () => {
    const now = performance.now()
    this.frameTimeAcc += now - this.lastFrame
    this.lastFrame = now

    this.controls.update()
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
    this.cpuTimeAcc += performance.now() - c0
    if (t && query) {
      t.gl.endQuery(t.ext.TIME_ELAPSED_EXT)
      t.pending.push(query)
    }
    this.pollGpuTimer()

    this.frames++
    if (now - this.lastStats >= STATS_INTERVAL_MS) {
      const elapsed = now - this.lastStats
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      this.onStats({
        fps: (this.frames * 1000) / elapsed,
        frameMs: this.frameTimeAcc / this.frames,
        cpuMs: this.cpuTimeAcc / this.frames,
        gpuMs: this.gpuMs,
        drawingBuffer: [size.x, size.y],
        steps: this.material.uniforms.uSteps.value as number,
      })
      this.frames = 0
      this.frameTimeAcc = 0
      this.cpuTimeAcc = 0
      this.lastStats = now
    }
  }
}
