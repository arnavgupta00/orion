import * as THREE from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { calculateFieldDispersion } from '../core/fieldDispersion';
import { accumulateZoomLog, presentZoom } from '../core/infiniteZoom';
import type { GestureMode, GestureSnapshot, ReticleState } from '../core/types';
import type { OrbCommand, OrbRuntimeState } from '../voice/types';

const VOID = 0x05080f;
const CAMERA_DISTANCE = 4.6;
const BASE_CORE_SCALE = 1.12;
const ENABLE_INERTIA = false;
const BASELINE_SOURCE_SIZE = 0.77;
const BASELINE_BRIGHTNESS = 1.5;
const SOURCE_WHITE = new THREE.Color(0xf8f4ff);

const NOISE_GLSL = /* glsl */ `
  vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
  vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
`;

const SHELL_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uCharge;
  uniform float uUnfold;
  uniform float uUnfoldReach;
  attribute vec3 aBarycentric;
  attribute vec3 aUnfoldOffset;
  varying vec3 vNormal;
  varying vec3 vLocalPos;
  varying vec3 vViewDir;
  varying float vDisp;
  varying vec3 vBarycentric;

  ${NOISE_GLSL}

  void main() {
    float t = uTime * 0.35;
    float n1 = snoise(normal * 1.2 + vec3(t * 0.6));
    float n2 = snoise(normal * 2.7 + vec3(t + 13.0));
    float n3 = snoise(normal * 5.4 + vec3(t * 1.3 + 71.0));
    float signal = snoise(normal * 3.4 + vec3(uTime * 1.2));
    float fbm = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
    float disp = fbm * 0.085 + signal * uEnergy * 0.16;

    vDisp = disp;
    vec3 displaced = position + normal * disp;
    if (uUnfold > 0.0001) {
      float unfoldEase = uUnfold * uUnfold * (3.0 - 2.0 * uUnfold);
      displaced += aUnfoldOffset * unfoldEase * uUnfoldReach;
    }
    vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vLocalPos = displaced;
    vViewDir = normalize(-mvPos.xyz);
    vBarycentric = aBarycentric;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SHELL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColCore;
  uniform vec3 uColRim;
  uniform vec3 uColAccent;
  uniform float uIridescence;
  uniform float uHueShift;
  uniform float uImmersion;
  uniform float uTunnel;
  uniform float uEnergy;
  uniform float uCharge;
  uniform float uUnfold;
  uniform float uBrightness;
  varying vec3 vNormal;
  varying vec3 vLocalPos;
  varying vec3 vViewDir;
  varying float vDisp;
  varying vec3 vBarycentric;

  vec3 flatNormal(vec3 p) {
    return normalize(cross(dFdx(p), dFdy(p)));
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  float triangleEdge() {
    vec3 width = fwidth(vBarycentric);
    vec3 inner = smoothstep(width * 0.72, width * 1.7, vBarycentric);
    return 1.0 - min(min(inner.x, inner.y), inner.z);
  }

  void main() {
    vec3 N = flatNormal(vLocalPos);
    if (!gl_FrontFacing) N *= -1.0;
    vec3 V = normalize(vViewDir);
    float NdotV = max(dot(N, V), 0.0);
    float fres = pow(1.0 - NdotV, 2.6);
    float n = vDisp * 0.5 + 0.5;
    vec3 body = mix(uColCore, uColRim, smoothstep(0.0, 1.0, n * 0.7 + fres * 0.5));

    float backRim = pow(
      1.0 - max(dot(N, normalize(V + vec3(0.6, 0.2, 0.0))), 0.0),
      3.0
    );
    body = mix(body, uColAccent, backRim * 0.55);

    float hue = uHueShift + uTime * 0.15 + fres * 0.6 + vLocalPos.y * 0.1;
    vec3 iridescent = hsv2rgb(vec3(fract(hue), 0.82, 0.88));
    vec3 color = body + iridescent * fres * (0.16 + 0.24 * uIridescence);
    color *= (0.55 + 0.45 * NdotV) * (1.0 - uEnergy * 0.18);
    float edge = triangleEdge();
    vec3 edgeTint = mix(uColRim, uColAccent, 0.48 + sin(uTime * 0.7) * 0.12);
    color *= 1.0 - uEnergy * 0.16;
    color += edgeTint * edge * (0.12 + uEnergy * 0.48);
    if (uCharge > 0.0001) {
      color += edgeTint * edge * uCharge * 0.28;
      color += uColRim * edge * uCharge * 0.1;
    }
    if (uUnfold > 0.0001) {
      color += edgeTint * edge * uUnfold * 0.24;
      color *= 1.0 - uUnfold * (1.0 - edge) * 0.74;
    }
    color = mix(color, color.bgr * 1.18 + uColAccent * 0.12, uImmersion * 0.48);
    color *= uBrightness;
    color = color / (1.0 + color * 0.55);
    float alpha = mix(1.0, 0.0, smoothstep(0.24, 0.9, uImmersion));
    alpha += uTunnel * 0.035;
    if (uUnfold > 0.0001) alpha = mix(alpha, edge * 0.32, uUnfold);
    gl_FragColor = vec4(color, alpha);
  }
`;

const AURA_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const AURA_FRAG = /* glsl */ `
  uniform vec3 uTint;
  uniform float uPulse;
  uniform float uImmersion;
  uniform float uUnfold;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float fres = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 1.6);
    float rim = pow(1.0 - fres, 2.2);
    float alpha = rim * (0.105 + uPulse * 0.07) * (1.0 - uImmersion);
    if (uUnfold > 0.0001) alpha *= 1.0 - uUnfold * 0.82;
    vec3 color = uTint * (0.4 + rim * 1.2);
    gl_FragColor = vec4(color, alpha);
  }
`;

const SPARK_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPulse;
  uniform float uVisibility;
  attribute float aSeed;
  varying float vAlpha;
  void main() {
    float angle = uTime * (0.05 + aSeed * 0.04) + aSeed * 6.2831;
    float c = cos(angle);
    float s = sin(angle);
    vec3 point = vec3(
      position.x * c - position.z * s,
      position.y + sin(uTime * 0.3 + aSeed * 5.0) * 0.04,
      position.x * s + position.z * c
    );
    vec4 mv = modelViewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * mv;
    float twinkle = 0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 12.0);
    vAlpha = (0.35 + 0.65 * twinkle) * (0.48 + uPulse * 0.12) * uVisibility;
    gl_PointSize = (1.4 + aSeed * 2.5) * (1.0 + uPulse * 0.16) * (24.0 / -mv.z);
  }
`;

const SPARK_FRAG = /* glsl */ `
  uniform vec3 uTint;
  varying float vAlpha;
  void main() {
    float distanceToCenter = length(gl_PointCoord - 0.5);
    float alpha = pow(smoothstep(0.5, 0.0, distanceToCenter), 1.8) * vAlpha * 0.72;
    gl_FragColor = vec4(uTint, alpha);
  }
`;

const FIELD_CELL_VERT = /* glsl */ `
  uniform vec2 uHandA;
  uniform vec2 uHandB;
  attribute float aSeed;
  attribute float aSignal;
  varying float vSeed;
  varying float vSignal;
  varying float vHand;
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    mat4 instanceModel = modelMatrix * instanceMatrix;
    vec4 world = instanceModel * vec4(position, 1.0);
    vec4 clip = projectionMatrix * viewMatrix * world;
    vec2 ndc = clip.xy / max(abs(clip.w), 0.0001);
    float handDistance = min(distance(ndc, uHandA), distance(ndc, uHandB));
    vHand = exp(-handDistance * 5.8);
    vSeed = aSeed;
    vSignal = aSignal;
    vNormal = normalize(mat3(instanceModel) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = clip;
  }
`;

const FIELD_CELL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uUnfold;
  uniform float uSignalProgress;
  uniform float uBaseAlpha;
  uniform float uGlass;
  uniform vec3 uTintA;
  uniform vec3 uTintB;
  varying float vSeed;
  varying float vSignal;
  varying float vHand;
  varying vec3 vNormal;
  varying vec3 vView;

  void main() {
    float signal = 1.0 - smoothstep(0.035, 0.14, abs(uSignalProgress - vSignal));
    float idle = pow(max(0.0, sin(uTime * 0.72 + vSeed * 31.0)), 22.0);
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);
    float intelligence = signal + idle * 0.22 + vHand * 0.46;
    vec3 color = mix(uTintA, uTintB, fract(vSeed * 3.71));
    color = mix(color, vec3(0.92, 0.97, 1.0), clamp(signal * 0.72 + vHand * 0.18, 0.0, 0.82));
    float frameAlpha = uBaseAlpha * (0.58 + vSeed * 0.34) + intelligence * 0.18;
    float glassAlpha = 0.008 + fresnel * 0.042 + signal * 0.035 + vHand * 0.022;
    float alpha = mix(frameAlpha, glassAlpha, uGlass) * uUnfold;
    gl_FragColor = vec4(color, alpha);
  }
`;

const BG_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BG_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorldPos;
  ${NOISE_GLSL}
  void main() {
    vec3 direction = normalize(vWorldPos);
    float band = pow(1.0 - abs(direction.y), 1.6);
    float noiseValue = snoise(direction * 1.6 + vec3(uTime * 0.02));
    float nebula = smoothstep(-0.2, 0.7, noiseValue) * 0.25;
    vec3 deep = vec3(0.016, 0.010, 0.045);
    vec3 horizon = vec3(0.040, 0.022, 0.110);
    vec3 color = mix(deep, horizon, band);
    color += vec3(0.12, 0.04, 0.22) * nebula * band;
    gl_FragColor = vec4(color, 1.0);
  }
`;

interface GesturePalette {
  core: THREE.Color;
  rim: THREE.Color;
  accent: THREE.Color;
  aura: THREE.Color;
  spark: THREE.Color;
  iridescence: number;
  hue: number;
}

const PALETTES: Record<'ready' | 'awake' | 'grab' | 'dual', GesturePalette> = {
  ready: palette([0.018, 0.01, 0.06], [0.2, 0.1, 0.5], [0.38, 0.14, 0.65], [0.22, 0.12, 0.55], [0.5, 0.38, 0.9], 0.08, 0.75),
  awake: palette([0.018, 0.01, 0.07], [0.26, 0.12, 0.55], [0.42, 0.2, 0.68], [0.3, 0.18, 0.6], [0.56, 0.44, 0.9], 0.14, 0.72),
  grab: palette([0.025, 0.01, 0.09], [0.34, 0.11, 0.58], [0.62, 0.16, 0.72], [0.35, 0.16, 0.65], [0.65, 0.4, 0.9], 0.35, 0),
  dual: palette([0.035, 0.01, 0.085], [0.4, 0.1, 0.55], [0.72, 0.2, 0.62], [0.4, 0.12, 0.62], [0.72, 0.4, 0.78], 0.28, 0.82),
};

interface Tether {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  positions: Float32Array;
}

interface DepthField {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  positions: Float32Array;
  angles: Float32Array;
  radii: Float32Array;
  depths: Float32Array;
}

interface FieldCellSystem {
  group: THREE.Group;
  outer: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  inner: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  glass: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  nodes: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  materials: THREE.ShaderMaterial[];
}

interface FieldCellSample {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  seed: number;
  signal: number;
}

export class SolarCoreScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.025, 100);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly afterimage = new AfterimagePass(0.86);
  private readonly coreGroup = new THREE.Group();
  private readonly depthGroup = new THREE.Group();
  private readonly worldLatticeGroup = new THREE.Group();
  private readonly shellMaterial: THREE.ShaderMaterial;
  private readonly auraMaterial: THREE.ShaderMaterial;
  private readonly soulMaterial: THREE.MeshBasicMaterial;
  private readonly lightReservoirMaterial: THREE.MeshBasicMaterial;
  private readonly radianceMaterial: THREE.MeshBasicMaterial;
  private readonly sparkMaterial: THREE.ShaderMaterial;
  private readonly nebulaMaterial: THREE.ShaderMaterial;
  private readonly shell: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly cage: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly aura: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly soul: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly lightReservoir: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly radiance: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly sparkRing: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly burstWave: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly worldLattice: Array<THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>> = [];
  private readonly fieldCells: FieldCellSystem;
  private readonly depthField: DepthField;
  private readonly portalCages: Array<THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>> = [];
  private readonly tethers = new Map<string, Tether>();
  private readonly timer = new THREE.Timer();
  private readonly fieldHandA = new THREE.Vector2(99, 99);
  private readonly fieldHandB = new THREE.Vector2(99, 99);
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private snapshot: GestureSnapshot;
  private previousMode: GestureMode = 'ready';
  private targetRotation = new THREE.Euler(0.08, -0.2, 0);
  private currentRotation = new THREE.Euler(0.08, -0.2, 0);
  private rotationVelocity = new THREE.Vector2();
  private voiceSpin = new THREE.Vector3();
  private targetZoomLog = 0;
  private currentZoomLog = 0;
  private dualBaseZoomLog = 0;
  private dualBaseRoll = 0;
  private previousFieldControl = false;
  private energy = 0;
  private targetEnergy = 0;
  private voiceEnergy: number | null = null;
  private voiceOutputTarget = 0;
  private voiceOutputLevel = 0;
  private targetCharge = 0;
  private charge = 0;
  private targetUnfold = 0;
  private voiceField: 'open' | 'collapsed' | null = null;
  private unfold = 0;
  private targetArmedCompression = 0;
  private armedCompression = 0;
  private burstAge = Number.POSITIVE_INFINITY;
  private sourceSize = BASELINE_SOURCE_SIZE;
  private brightness = BASELINE_BRIGHTNESS;
  private fieldSignalAge = Number.POSITIVE_INFINITY;
  private shellDissolve = 0;
  private sourceFocus = 0;
  private immersion = 0;
  private currentCore = PALETTES.ready.core.clone();
  private currentRim = PALETTES.ready.rim.clone();
  private currentAccent = PALETTES.ready.accent.clone();
  private currentAura = PALETTES.ready.aura.clone();
  private currentSpark = PALETTES.ready.spark.clone();
  private currentIridescence = PALETTES.ready.iridescence;
  private currentHue = PALETTES.ready.hue;
  private shellAppearance: GesturePalette | null = null;
  private shellAppearanceHex: string | null = null;
  private sourceAppearance: THREE.Color | null = null;
  private sourceAppearanceHighlight: THREE.Color | null = null;
  private sourceAppearanceHex: string | null = null;
  private fieldAppearanceHex: string | null = null;
  private frameTimes: number[] = [];
  private animationFrame = 0;
  private destroyed = false;
  private readonly onResize = () => this.resize();
  private readonly onReducedMotion = () => this.applyMotionPreference();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onRenderFps?: (fps: number) => void,
    private readonly frozen = false,
  ) {
    this.snapshot = idleSnapshot();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(VOID, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.camera.position.set(0, 0, CAMERA_DISTANCE);
    this.timer.connect(document);

    const nebula = this.createNebulaSphere();
    this.nebulaMaterial = nebula.material;
    this.scene.add(nebula, this.createBackgroundStars());

    this.shellMaterial = this.createShellMaterial();
    this.auraMaterial = this.createAuraMaterial();
    this.soulMaterial = new THREE.MeshBasicMaterial({
      color: PALETTES.ready.rim,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.lightReservoirMaterial = new THREE.MeshBasicMaterial({
      color: PALETTES.ready.accent,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.radianceMaterial = new THREE.MeshBasicMaterial({
      color: PALETTES.ready.accent,
      transparent: true,
      opacity: 0.18,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.sparkMaterial = this.createSparkMaterial();

    this.soul = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.soulMaterial);
    this.soul.scale.setScalar(0.32);
    this.lightReservoir = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.82, 4),
      this.lightReservoirMaterial,
    );
    this.radiance = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.76, 4),
      this.radianceMaterial,
    );
    this.shell = new THREE.Mesh(createFacetedGeometry(), this.shellMaterial);
    this.shell.scale.setScalar(1.02);
    this.cage = new THREE.LineSegments(
      createCageGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x9fb6ff,
        transparent: true,
        opacity: 0.085,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.cage.scale.setScalar(1.28);
    this.aura = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5), this.auraMaterial);
    this.aura.scale.setScalar(1.75);
    this.sparkRing = this.createSparkRing();
    this.shell.renderOrder = 1;
    this.lightReservoir.renderOrder = 2;
    this.radiance.renderOrder = 2;
    this.soul.renderOrder = 2;
    this.cage.renderOrder = 3;
    this.aura.renderOrder = 3;
    this.sparkRing.renderOrder = 3;
    this.coreGroup.add(
      this.shell,
      this.lightReservoir,
      this.radiance,
      this.soul,
      this.cage,
      this.aura,
      this.sparkRing,
    );
    this.scene.add(this.coreGroup);

    this.burstWave = new THREE.LineSegments(
      createCageGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xd8ecff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.burstWave.visible = false;
    this.burstWave.frustumCulled = false;
    this.burstWave.renderOrder = 8;
    this.scene.add(this.burstWave);

    this.createWorldLattice().forEach((lattice) => {
      this.worldLattice.push(lattice);
      this.worldLatticeGroup.add(lattice);
    });
    this.fieldCells = this.createFieldCellSystem();
    this.worldLatticeGroup.add(this.fieldCells.group);
    this.scene.add(this.worldLatticeGroup);

    this.depthField = this.createDepthField();
    this.depthGroup.add(this.depthField.points);
    this.createPortalCages().forEach((portal) => {
      this.portalCages.push(portal);
      this.depthGroup.add(portal);
    });
    this.scene.add(this.depthGroup);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.34, 0.3);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.afterimage);
    this.composer.addPass(new OutputPass());

    this.applyMotionPreference();
    this.resize();
    window.addEventListener('resize', this.onResize);
    this.reducedMotion.addEventListener('change', this.onReducedMotion);
    this.animate();
  }

  setGesture(snapshot: GestureSnapshot): void {
    this.snapshot = snapshot;
    const handActive = snapshot.reticles.some((reticle) => reticle.visibility >= 0.35);
    this.targetEnergy = handActive ? snapshot.intensity : this.voiceEnergy ?? snapshot.intensity;
    this.targetCharge = snapshot.mode === 'charge' ? snapshot.chargeLevel : 0;
    this.targetArmedCompression = snapshot.mode === 'unfold-armed' ? 1 : 0;
    if (handActive) {
      this.targetUnfold = snapshot.mode === 'unfold' || snapshot.mode === 'expanded' ? 1 : 0;
      if (['unfold', 'expanded', 'collapse'].includes(snapshot.mode)) this.voiceField = null;
    } else {
      this.targetUnfold = this.voiceField === 'open' ? 1 : this.voiceField === 'collapsed' ? 0 : this.targetUnfold;
    }

    if (snapshot.mode === 'burst' && this.previousMode !== 'burst') {
      this.burstAge = 0;
    }
    if (snapshot.mode === 'unfold' && this.previousMode !== 'unfold') {
      this.fieldSignalAge = 0;
    }

    if (snapshot.mode === 'grab') {
      this.targetRotation.x += snapshot.rotationDelta.x;
      this.targetRotation.y += snapshot.rotationDelta.y;
      if (ENABLE_INERTIA) {
        this.rotationVelocity.set(snapshot.rotationDelta.x, snapshot.rotationDelta.y);
      }
    }

    if (snapshot.mode === 'dual') {
      if (this.previousMode !== 'dual') {
        this.dualBaseZoomLog = this.targetZoomLog;
        this.dualBaseRoll = this.targetRotation.z;
      }
      this.targetZoomLog = accumulateZoomLog(this.dualBaseZoomLog, snapshot.scaleRatio);
      this.targetRotation.z = this.dualBaseRoll + snapshot.rollDelta;
      this.targetRotation.x += snapshot.rotationDelta.x * 0.12;
      this.targetRotation.y += snapshot.rotationDelta.y * 0.12;
    }

    if (snapshot.mode === 'expanded' && snapshot.fieldControl) {
      if (!this.previousFieldControl) {
        this.dualBaseZoomLog = this.targetZoomLog;
        this.dualBaseRoll = this.targetRotation.z;
      }
      this.targetZoomLog = accumulateZoomLog(this.dualBaseZoomLog, snapshot.scaleRatio);
      this.targetRotation.z = this.dualBaseRoll + snapshot.rollDelta;
      this.targetRotation.x += snapshot.rotationDelta.x * 0.12;
      this.targetRotation.y += snapshot.rotationDelta.y * 0.12;
    }

    this.previousFieldControl = snapshot.fieldControl;
    this.previousMode = snapshot.mode;
    this.syncTethers(snapshot.reticles);
  }

  applyVoiceCommand(command: OrbCommand): void {
    switch (command.kind) {
      case 'field':
        this.voiceField = command.state === 'open' ? 'open' : 'collapsed';
        this.targetUnfold = command.state === 'open' ? 1 : 0;
        if (command.state === 'open') this.fieldSignalAge = 0;
        break;
      case 'burst':
        this.burstAge = 0;
        this.voiceEnergy = Math.min(1.5, Math.max(0.2, command.strength));
        this.targetEnergy = this.voiceEnergy;
        break;
      case 'zoom':
        this.targetZoomLog = accumulateZoomLog(this.targetZoomLog, command.factor);
        break;
      case 'rotate':
        this.targetRotation.x += command.pitch;
        this.targetRotation.y += command.yaw;
        this.targetRotation.z += command.roll;
        break;
      case 'spin':
        this.voiceSpin.set(0, 0, 0);
        this.voiceSpin[command.axis] = command.speed;
        break;
      case 'stop-motion':
        this.cancelVoiceMotion();
        break;
      case 'core':
        if (command.size !== undefined) this.sourceSize = clamp(command.size, 0.08, 25);
        if (command.brightness !== undefined) this.brightness = clamp(command.brightness, 0.1, 4);
        if (command.energy !== undefined) {
          this.voiceEnergy = clamp(command.energy, 0, 1.5);
          this.targetEnergy = this.voiceEnergy;
        }
        break;
      case 'appearance': {
        const color = new THREE.Color(command.color);
        if (command.target === 'shell' || command.target === 'all') {
          this.shellAppearance = appearancePalette(color);
          this.shellAppearanceHex = command.color.toUpperCase();
        }
        if (command.target === 'light-source' || command.target === 'all') {
          this.sourceAppearance = color.clone();
          this.sourceAppearanceHighlight = color.clone().lerp(SOURCE_WHITE, 0.42);
          this.sourceAppearanceHex = command.color.toUpperCase();
        }
        if (command.target === 'field' || command.target === 'all') {
          this.fieldAppearanceHex = command.color.toUpperCase();
          this.applyFieldAppearance(color);
        }
        break;
      }
      case 'reset':
        this.sourceSize = BASELINE_SOURCE_SIZE;
        this.brightness = BASELINE_BRIGHTNESS;
        this.voiceEnergy = null;
        this.voiceField = 'collapsed';
        this.targetEnergy = 0;
        this.targetUnfold = 0;
        this.targetZoomLog = 0;
        this.voiceSpin.set(0, 0, 0);
        this.targetRotation.set(0.08, -0.2, 0);
        this.rotationVelocity.set(0, 0);
        this.shellAppearance = null;
        this.shellAppearanceHex = null;
        this.sourceAppearance = null;
        this.sourceAppearanceHighlight = null;
        this.sourceAppearanceHex = null;
        this.fieldAppearanceHex = null;
        this.applyFieldAppearance(null);
        break;
    }
  }

  setVoiceOutputLevel(level: number): void {
    this.voiceOutputTarget = clamp(level, 0, 1);
  }

  getRuntimeState(): OrbRuntimeState {
    return {
      mode: this.snapshot.mode,
      fieldOpen: this.targetUnfold >= 0.5,
      zoomLog: this.currentZoomLog,
      sourceSize: this.sourceSize,
      brightness: this.brightness,
      energy: this.energy,
      appearance: {
        shell: this.shellAppearanceHex,
        lightSource: this.sourceAppearanceHex,
        field: this.fieldAppearanceHex,
      },
    };
  }

  private applyFieldAppearance(color: THREE.Color | null): void {
    const worldDefaults = [0x9a7cff, 0x75ccff, 0xc19cff];
    this.cage.material.color.set(color ? color.clone().lerp(SOURCE_WHITE, 0.28) : 0x9fb6ff);
    this.burstWave.material.color.set(color ? color.clone().lerp(SOURCE_WHITE, 0.52) : 0xd8ecff);
    this.worldLattice.forEach((lattice, index) => {
      lattice.material.color.set(color
        ? color.clone().lerp(SOURCE_WHITE, 0.1 + index * 0.13)
        : worldDefaults[index]!);
    });
    this.portalCages.forEach((portal, index) => {
      portal.material.color.set(color
        ? color.clone().lerp(SOURCE_WHITE, index % 2 === 0 ? 0.18 : 0.38)
        : index % 2 === 0 ? 0xb78cff : 0x72d8ff);
    });
    this.depthField.points.material.color.set(color ? color.clone().lerp(SOURCE_WHITE, 0.3) : 0xc7a7ff);
    this.fieldCells.materials.forEach((material, index) => {
      const tintA = material.uniforms.uTintA!.value as THREE.Color;
      const tintB = material.uniforms.uTintB!.value as THREE.Color;
      if (color) {
        tintA.copy(color).lerp(SOURCE_WHITE, index === 3 ? 0.48 : 0.16);
        tintB.copy(color).lerp(SOURCE_WHITE, index === 3 ? 0.66 : 0.38);
      } else {
        tintA.set(index === 3 ? 0xbaf7ff : 0x6edcff);
        tintB.set(index === 3 ? 0xd4baff : 0xc27bff);
      }
    });
  }

  cancelVoiceMotion(): void {
    this.voiceSpin.set(0, 0, 0);
    this.rotationVelocity.set(0, 0);
    this.targetRotation.copy(this.currentRotation);
    this.targetZoomLog = this.currentZoomLog;
  }

  dispose(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.onResize);
    this.reducedMotion.removeEventListener('change', this.onReducedMotion);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.timer.dispose();
  }

  private createShellMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 0 },
        uCharge: { value: 0 },
        uUnfold: { value: 0 },
        uUnfoldReach: { value: 1 },
        uColCore: { value: PALETTES.ready.core.clone() },
        uColRim: { value: PALETTES.ready.rim.clone() },
        uColAccent: { value: PALETTES.ready.accent.clone() },
        uIridescence: { value: PALETTES.ready.iridescence },
        uHueShift: { value: PALETTES.ready.hue },
        uImmersion: { value: 0 },
        uTunnel: { value: 0 },
        uBrightness: { value: 1 },
      },
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
    });
  }

  private createAuraMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTint: { value: PALETTES.ready.aura.clone() },
        uPulse: { value: 0 },
        uImmersion: { value: 0 },
        uUnfold: { value: 0 },
      },
      vertexShader: AURA_VERT,
      fragmentShader: AURA_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
  }

  private createSparkMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: 0 },
        uVisibility: { value: 1 },
        uTint: { value: PALETTES.ready.spark.clone() },
      },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  private createSparkRing(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const count = 1500;
    const random = seededRandom(707);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const radius = 2.6 + random() * 0.8;
      const theta = random() * Math.PI * 2;
      const yBias = (random() - 0.5) * 0.6;
      const phi = Math.acos(clamp(yBias, -1, 1));
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = radius * Math.cos(phi);
      positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      seeds[index] = random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    return new THREE.Points(geometry, this.sparkMaterial);
  }

  private createNebulaSphere(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(50, 32, 32), material);
  }

  private createBackgroundStars(): THREE.Points {
    const count = 2800;
    const random = seededRandom(20260716);
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const radius = 12 + random() * 30;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[index * 3 + 2] = radius * Math.cos(phi);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xb9a4ff,
        size: 0.026,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
  }

  private createDepthField(): DepthField {
    const count = 1100;
    const random = seededRandom(909);
    const positions = new Float32Array(count * 3);
    const angles = new Float32Array(count);
    const radii = new Float32Array(count);
    const depths = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      angles[index] = random() * Math.PI * 2;
      radii[index] = 0.35 + Math.pow(random(), 0.55) * 4.8;
      depths[index] = random() * 42;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xc7a7ff,
      size: 0.055,
      transparent: true,
      opacity: 0,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.visible = false;
    points.frustumCulled = false;
    return { points, positions, angles, radii, depths };
  }

  private createPortalCages(): Array<THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>> {
    return Array.from({ length: 7 }, (_, index) => {
      const portal = new THREE.LineSegments(
        createCageGeometry(),
        new THREE.LineBasicMaterial({
          color: index % 2 === 0 ? 0xb78cff : 0x72d8ff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      portal.visible = false;
      return portal;
    });
  }

  private createWorldLattice(): Array<THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>> {
    return [0x9a7cff, 0x75ccff, 0xc19cff].map((color, index) => {
      const lattice = new THREE.LineSegments(
        createCageGeometry(),
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      lattice.visible = false;
      lattice.frustumCulled = false;
      lattice.renderOrder = 4 + index;
      lattice.rotation.set(index * 0.42, index * -0.58, index * 0.31);
      return lattice;
    });
  }

  private createFieldCellSystem(): FieldCellSystem {
    const samples = createFieldCellSamples(54);
    const innerSamples = samples.filter((_, index) => index % 4 === 1).slice(0, 13);
    const glassSamples = samples.filter((_, index) => index % 8 === 3).slice(0, 7);
    const nodeSamples = createFieldNodeSamples(innerSamples);
    const outerMaterial = this.createFieldCellMaterial(0.07, false);
    const innerMaterial = this.createFieldCellMaterial(0.115, false);
    const glassMaterial = this.createFieldCellMaterial(0.006, true);
    const nodeMaterial = this.createFieldCellMaterial(0.055, false);
    (nodeMaterial.uniforms.uTintA!.value as THREE.Color).set(0xbaf7ff);
    (nodeMaterial.uniforms.uTintB!.value as THREE.Color).set(0xd4baff);

    const outer = createFieldInstances(
      createTriangleFrameGeometry(0.055),
      outerMaterial,
      samples,
      1,
    );
    const inner = createFieldInstances(
      createTriangleFrameGeometry(0.08),
      innerMaterial,
      innerSamples,
      0.64,
    );
    const glass = createFieldInstances(
      createTriangleFaceGeometry(),
      glassMaterial,
      glassSamples,
      0.88,
    );
    const nodes = createFieldInstances(
      new THREE.CircleGeometry(1, 10),
      nodeMaterial,
      nodeSamples,
      1,
    );
    outer.renderOrder = 5;
    glass.renderOrder = 5;
    inner.renderOrder = 6;
    nodes.renderOrder = 7;

    const group = new THREE.Group();
    group.visible = false;
    group.add(glass, outer, inner, nodes);
    return {
      group,
      outer,
      inner,
      glass,
      nodes,
      materials: [outerMaterial, innerMaterial, glassMaterial, nodeMaterial],
    };
  }

  private createFieldCellMaterial(baseAlpha: number, glass: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uUnfold: { value: 0 },
        uSignalProgress: { value: 2 },
        uBaseAlpha: { value: baseAlpha },
        uGlass: { value: glass ? 1 : 0 },
        uTintA: { value: new THREE.Color(0x6edcff) },
        uTintB: { value: new THREE.Color(0xc27bff) },
        uHandA: { value: new THREE.Vector2(99, 99) },
        uHandB: { value: new THREE.Vector2(99, 99) },
      },
      vertexShader: FIELD_CELL_VERT,
      fragmentShader: FIELD_CELL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: glass ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
  }

  private syncTethers(reticles: ReticleState[]): void {
    const activeIds = new Set(reticles.map((reticle) => reticle.handId));
    for (const [id, tether] of this.tethers) {
      if (!activeIds.has(id)) tether.points.visible = false;
    }

    reticles.forEach((reticle, index) => {
      let tether = this.tethers.get(reticle.handId);
      if (!tether) {
        tether = this.createTether(index === 0 ? 0xb78cff : 0x72d8ff);
        this.tethers.set(reticle.handId, tether);
        this.scene.add(tether.points);
      }
      this.updateTether(tether, reticle);
    });
  }

  private createTether(color: number): Tether {
    const positions = new Float32Array(48 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color,
      size: 0.06,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 20;
    return { points, positions };
  }

  private updateTether(tether: Tether, reticle: ReticleState): void {
    const opacity = reticle.visibility * Math.pow(reticle.pinchStrength, 1.35) * 0.9;
    tether.points.visible = opacity > 0.025;
    tether.points.material.opacity = opacity;
    if (!tether.points.visible) return;

    const end = this.screenToWorld(reticle.x, reticle.y);
    const direction = end.clone().normalize();
    const shellRadius = this.coreGroup.scale.x * this.shell.scale.x;
    const startRadius = lerp(shellRadius, 0.22, this.shellDissolve);
    const start = direction.multiplyScalar(startRadius);
    const lateral = new THREE.Vector3(-end.y, end.x, 0).normalize();
    const elapsed = this.timer.getElapsed();
    for (let index = 0; index < 48; index += 1) {
      const progress = index / 47;
      const point = start.clone().lerp(end, progress);
      const bow = Math.sin(progress * Math.PI) * (0.14 + reticle.pinchStrength * 0.2);
      const shimmer = Math.sin(elapsed * 8 + index * 1.71) * 0.024 * (1 - progress);
      point.addScaledVector(lateral, bow + shimmer);
      tether.positions[index * 3] = point.x;
      tether.positions[index * 3 + 1] = point.y;
      tether.positions[index * 3 + 2] = point.z;
    }
    const attribute = tether.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
  }

  private updateImmersion(travel: number, immersion: number, elapsed: number): void {
    const material = this.depthField.points.material;
    this.depthField.points.visible = immersion > 0.002;
    material.opacity = immersion * 0.72;
    if (!this.depthField.points.visible) {
      this.portalCages.forEach((portal) => { portal.visible = false; });
      return;
    }

    const forward = travel * 10;
    for (let index = 0; index < this.depthField.angles.length; index += 1) {
      const phase = positiveModulo(this.depthField.depths[index]! + forward, 42);
      const near = phase / 42;
      const angle = this.depthField.angles[index]! + elapsed * (0.015 + near * 0.02);
      const radius = this.depthField.radii[index]! * (0.32 + near * 1.85);
      this.depthField.positions[index * 3] = Math.cos(angle) * radius;
      this.depthField.positions[index * 3 + 1] = Math.sin(angle) * radius;
      this.depthField.positions[index * 3 + 2] = -34 + phase;
    }
    const position = this.depthField.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    position.needsUpdate = true;

    this.portalCages.forEach((portal, index) => {
      const phase = positiveModulo((index / this.portalCages.length) * 42 + forward, 42);
      const near = phase / 42;
      portal.visible = true;
      portal.position.z = -34 + phase;
      portal.scale.setScalar(0.65 + near * 4.4);
      portal.rotation.x = elapsed * 0.035 + index * 0.45;
      portal.rotation.z = -elapsed * 0.052 + index * 0.72;
      portal.material.opacity = immersion * (0.025 + near * 0.17);
    });
  }

  private screenToWorld(x: number, y: number): THREE.Vector3 {
    const projected = new THREE.Vector3(x * 2 - 1, -(y * 2 - 1), 0.2).unproject(this.camera);
    const direction = projected.sub(this.camera.position).normalize();
    const distance = -this.camera.position.z / direction.z;
    return this.camera.position.clone().add(direction.multiplyScalar(distance));
  }

  private animate = (timestamp = performance.now()): void => {
    if (this.destroyed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    this.timer.update(timestamp);
    const delta = Math.min(this.timer.getDelta(), 0.05);
    const elapsed = this.frozen ? 3.25 : this.timer.getElapsed();
    const motionFactor = this.frozen ? 0 : this.reducedMotion.matches ? 0.25 : 1;

    if (this.voiceSpin.lengthSq() > 0 && motionFactor > 0) {
      this.targetRotation.x += this.voiceSpin.x * delta * motionFactor;
      this.targetRotation.y += this.voiceSpin.y * delta * motionFactor;
      this.targetRotation.z += this.voiceSpin.z * delta * motionFactor;
    }

    if (ENABLE_INERTIA && this.snapshot.mode !== 'grab' && this.snapshot.mode !== 'dual') {
      this.targetRotation.x += this.rotationVelocity.x * motionFactor;
      this.targetRotation.y += this.rotationVelocity.y * motionFactor;
      this.rotationVelocity.multiplyScalar(Math.pow(0.012, delta));
    } else if (!ENABLE_INERTIA) {
      this.rotationVelocity.set(0, 0);
    }

    this.currentRotation.x = THREE.MathUtils.damp(this.currentRotation.x, this.targetRotation.x, 10, delta);
    this.currentRotation.y = THREE.MathUtils.damp(this.currentRotation.y, this.targetRotation.y, 10, delta);
    this.currentRotation.z = THREE.MathUtils.damp(this.currentRotation.z, this.targetRotation.z, 9, delta);
    this.coreGroup.rotation.copy(this.currentRotation);
    this.worldLatticeGroup.rotation.copy(this.currentRotation);

    this.currentZoomLog = THREE.MathUtils.damp(this.currentZoomLog, this.targetZoomLog, 6.5, delta);
    const zoom = presentZoom(this.currentZoomLog);
    this.shellDissolve = zoom.shellDissolve;
    this.sourceFocus = zoom.sourceFocus;
    this.immersion = zoom.immersion;
    const presentedScale = zoom.surfaceScale * BASE_CORE_SCALE;
    const fieldDispersion = calculateFieldDispersion(
      presentedScale,
      this.viewportWorldRadius(),
    );

    this.charge = THREE.MathUtils.damp(this.charge, this.targetCharge, 9, delta);
    this.armedCompression = THREE.MathUtils.damp(
      this.armedCompression,
      this.targetArmedCompression,
      12,
      delta,
    );
    const unfoldDamping = this.targetUnfold > this.unfold ? 4.8 : 6.5;
    this.unfold = THREE.MathUtils.damp(this.unfold, this.targetUnfold, unfoldDamping, delta);
    this.burstAge += delta;
    this.fieldSignalAge += delta;
    const burstProgress = this.frozen && this.snapshot.mode === 'burst'
      ? 0.42
      : clamp(this.burstAge / 0.72, 0, 1);
    const burstImpulse = burstProgress < 1
      ? Math.sin(burstProgress * Math.PI) * Math.pow(1 - burstProgress, 0.45)
      : 0;
    this.voiceOutputLevel = THREE.MathUtils.damp(
      this.voiceOutputLevel,
      this.voiceOutputTarget,
      this.voiceOutputTarget > this.voiceOutputLevel ? 18 : 8,
      delta,
    );
    const voicePulse = this.reducedMotion.matches ? this.voiceOutputLevel * 0.35 : this.voiceOutputLevel;
    const interactionScale =
      (1 - this.charge * 0.055 - this.armedCompression * 0.045 + burstImpulse * 0.032) *
      (1 + voicePulse * 0.026);
    this.coreGroup.scale.setScalar(presentedScale * interactionScale);
    this.coreGroup.position.y = Math.sin(elapsed * 11.5) * voicePulse * 0.018;

    this.energy = THREE.MathUtils.damp(this.energy, this.targetEnergy, 7, delta);
    const targetPalette = paletteFor(this.snapshot.mode);
    const paletteMix = Math.min(1, delta * 2.4);
    this.currentCore.lerp(targetPalette.core, paletteMix);
    this.currentRim.lerp(targetPalette.rim, paletteMix);
    this.currentAccent.lerp(targetPalette.accent, paletteMix);
    this.currentAura.lerp(targetPalette.aura, paletteMix);
    this.currentSpark.lerp(targetPalette.spark, paletteMix);
    this.currentIridescence = lerp(this.currentIridescence, targetPalette.iridescence, paletteMix);
    if ((this.snapshot.mode === 'grab' || this.snapshot.mode === 'dual') && motionFactor > 0) {
      this.currentHue = positiveModulo(this.currentHue + delta * 0.1, 1);
    } else {
      this.currentHue = lerp(this.currentHue, targetPalette.hue, paletteMix);
    }

    this.shellMaterial.uniforms.uTime!.value = elapsed;
    this.shellMaterial.uniforms.uEnergy!.value = clamp(
      this.energy + this.charge * 0.12 + burstImpulse * 0.14 + voicePulse * 0.26,
      0,
      1.35,
    );
    this.shellMaterial.uniforms.uCharge!.value = this.charge;
    this.shellMaterial.uniforms.uUnfold!.value = this.unfold;
    this.shellMaterial.uniforms.uUnfoldReach!.value = fieldDispersion.shardReach;
    const shellPalette = this.shellAppearance;
    (this.shellMaterial.uniforms.uColCore!.value as THREE.Color).copy(shellPalette?.core ?? this.currentCore);
    (this.shellMaterial.uniforms.uColRim!.value as THREE.Color).copy(shellPalette?.rim ?? this.currentRim);
    (this.shellMaterial.uniforms.uColAccent!.value as THREE.Color).copy(shellPalette?.accent ?? this.currentAccent);
    this.shellMaterial.uniforms.uIridescence!.value = shellPalette?.iridescence ?? this.currentIridescence;
    this.shellMaterial.uniforms.uHueShift!.value = shellPalette?.hue ?? this.currentHue;
    this.shellMaterial.uniforms.uImmersion!.value = this.shellDissolve;
    this.shellMaterial.uniforms.uTunnel!.value = this.immersion;
    this.shellMaterial.uniforms.uBrightness!.value = this.brightness;
    this.shellMaterial.depthWrite = this.shellDissolve < 0.16 && this.unfold < 0.08;

    (this.auraMaterial.uniforms.uTint!.value as THREE.Color).copy(shellPalette?.aura ?? this.currentAura);
    this.auraMaterial.uniforms.uPulse!.value = this.energy + voicePulse * 0.34;
    this.auraMaterial.uniforms.uImmersion!.value = this.shellDissolve;
    this.auraMaterial.uniforms.uUnfold!.value = this.unfold;
    (this.sparkMaterial.uniforms.uTint!.value as THREE.Color).copy(shellPalette?.spark ?? this.currentSpark);
    this.sparkMaterial.uniforms.uTime!.value = elapsed;
    this.sparkMaterial.uniforms.uPulse!.value = this.energy + voicePulse * 0.28;
    this.sparkMaterial.uniforms.uVisibility!.value =
      (1 - this.shellDissolve) * (1 - this.unfold * 0.68);
    this.nebulaMaterial.uniforms.uTime!.value = elapsed;

    this.shell.rotation.y += delta * (0.04 + this.charge * 0.025 + voicePulse * 0.09) * motionFactor;
    this.shell.rotation.x += delta * (0.015 + this.charge * 0.012 + voicePulse * 0.035) * motionFactor;
    this.shell.scale.setScalar(
      1.02 * (1 - this.charge * 0.035 - this.armedCompression * 0.025 + burstImpulse * 0.018),
    );
    this.cage.rotation.y -= delta * 0.06 * motionFactor;
    this.cage.rotation.x += delta * 0.03 * motionFactor;
    this.cage.scale.setScalar(
      1.28 * lerp(1, fieldDispersion.cageLocalMultiplier, smoothstep(0.05, 1, this.unfold)) *
        (1 - this.charge * 0.035 - this.armedCompression * 0.025),
    );
    this.cage.material.opacity =
      (0.085 + this.charge * 0.075 + this.unfold * 0.055) * (1 - this.shellDissolve);
    this.aura.scale.setScalar(1.75 * (1 - this.charge * 0.035 - this.armedCompression * 0.025));
    const sourceVisibility = 1 - this.immersion * 0.96;
    this.lightReservoir.scale.setScalar(
      (1 + Math.sin(elapsed * 1.7) * 0.016 * motionFactor + voicePulse * 0.035) *
        (1 - this.charge * 0.075 - this.armedCompression * 0.04),
    );
    setMaterialSide(
      this.lightReservoirMaterial,
      0.82 * this.lightReservoir.scale.x * presentedScale > CAMERA_DISTANCE,
    );
    this.lightReservoirMaterial.opacity =
      clamp(
        (0.22 + this.energy * 0.16 + this.charge * 0.035 + burstImpulse * 0.04) *
          (1 - this.shellDissolve) *
          sourceVisibility *
          (1 - this.unfold * 0.68) *
          this.brightness,
        0,
        0.92,
      );
    this.lightReservoirMaterial.color
      .copy(this.sourceAppearance ?? this.currentAccent)
      .lerp(this.sourceAppearanceHighlight ?? this.currentRim, 0.38)
      .lerp(SOURCE_WHITE, 0.18);
    const soulNaturalScale =
      (0.32 + this.energy * 0.06 + this.charge * 0.028 + burstImpulse * 0.02 + voicePulse * 0.018) *
      this.sourceSize;
    const soulBaseScale = Math.min(
      soulNaturalScale,
      (1.15 * this.sourceSize) / presentedScale,
    );
    const coronaWorldRadius = 1.15 + zoom.sourceApproach * 1.25;
    const soulFocusedScale = (coronaWorldRadius * this.sourceSize) / presentedScale;
    this.soul.scale.setScalar(lerp(soulBaseScale, soulFocusedScale, this.shellDissolve));
    setMaterialSide(
      this.soulMaterial,
      this.soul.scale.x * presentedScale > CAMERA_DISTANCE,
    );
    this.soulMaterial.opacity =
      clamp(
        (0.44 + this.energy * 0.07 + this.sourceFocus * 0.08 + this.charge * 0.035 + burstImpulse * 0.05) *
          sourceVisibility *
          this.brightness,
        0,
        1,
      );
    this.soulMaterial.color
      .copy(this.sourceAppearanceHighlight ?? this.currentRim)
      .lerp(SOURCE_WHITE, 0.4 + this.sourceFocus * 0.25);
    const radiancePulse =
      1 + Math.sin(elapsed * 2.2) * 0.018 * motionFactor + this.charge * 0.045 + voicePulse * 0.045;
    const radianceBaseScale = Math.min(
      radiancePulse,
      1.35 / (0.76 * presentedScale),
    );
    const radianceFocusedScale =
      (coronaWorldRadius + 0.38) / (0.76 * presentedScale);
    this.radiance.scale.setScalar(
      lerp(radianceBaseScale, radianceFocusedScale, this.shellDissolve),
    );
    setMaterialSide(
      this.radianceMaterial,
      0.76 * this.radiance.scale.x * presentedScale > CAMERA_DISTANCE,
    );
    this.radianceMaterial.opacity =
      clamp(
        (0.14 + this.energy * 0.12 + this.sourceFocus * 0.1 + this.charge * 0.04 + burstImpulse * 0.04) *
          (1 - this.immersion * 0.94) *
          (1 - this.unfold * 0.52) *
          this.brightness,
        0,
        1,
      );
    this.radianceMaterial.color
      .copy(this.sourceAppearance ?? this.currentAccent)
      .lerp(this.sourceAppearanceHighlight ?? this.currentRim, 0.28)
      .lerp(SOURCE_WHITE, this.sourceFocus * 0.18);

    this.updateImmersion(zoom.travel, this.immersion, elapsed);
    this.updateWorldLattice(elapsed, motionFactor, fieldDispersion.worldScales);
    this.updateBurstWave(burstProgress, presentedScale);
    const parallax =
      (1 - Math.max(this.shellDissolve, this.immersion)) *
      (1 - this.unfold * 0.86) *
      motionFactor;
    this.camera.position.x = Math.sin(elapsed * 0.18) * 0.14 * parallax;
    this.camera.position.y = Math.cos(elapsed * 0.14) * 0.08 * parallax;
    this.camera.position.z = CAMERA_DISTANCE + Math.sin(elapsed * 0.22) * 0.08 * parallax;
    this.camera.lookAt(0, 0, 0);

    this.bloom.strength =
      clamp(
        (0.46 +
          this.energy * 0.06 +
          this.sourceFocus * 0.06 +
          this.immersion * 0.1 +
          this.charge * 0.018 +
          burstImpulse * 0.035 +
          this.unfold * 0.025) *
          (1 + voicePulse * 0.08) *
          this.brightness,
        0.18,
        1.2,
      );
    if (this.afterimage.enabled) {
      this.afterimage.uniforms.damp!.value =
        this.snapshot.mode === 'burst' ||
        this.snapshot.mode === 'unfold' ||
        this.snapshot.mode === 'collapse'
          ? 0.7
          : 0.86;
    }
    this.syncTethers(this.snapshot.reticles);
    this.composer.render(delta);
    this.trackFps();
  };

  private updateWorldLattice(
    elapsed: number,
    motionFactor: number,
    targetScales: [number, number, number],
  ): void {
    const targetOpacities = [0.082, 0.048, 0.026];
    this.worldLattice.forEach((lattice, index) => {
      const delay = index * 0.075;
      const local = smoothstep(delay, Math.min(1, 0.74 + delay), this.unfold);
      lattice.visible = local > 0.002;
      if (!lattice.visible) return;
      lattice.scale.setScalar(lerp(1.18, targetScales[index]!, local));
      lattice.material.opacity = targetOpacities[index]! * local;
      lattice.rotation.x = index * 0.42 + elapsed * (0.006 + index * 0.002) * motionFactor;
      lattice.rotation.y = index * -0.58 - elapsed * (0.008 + index * 0.0015) * motionFactor;
      lattice.rotation.z = index * 0.31 + elapsed * 0.004 * motionFactor;
      lattice.position.z = lerp(0, index === 1 ? -1.4 : index === 2 ? 1.1 : 0, local);
    });
    this.updateFieldCells(elapsed, targetScales[0]);
  }

  private updateFieldCells(elapsed: number, targetScale: number): void {
    const reveal = smoothstep(0.08, 0.72, this.unfold);
    this.fieldCells.group.visible = reveal > 0.002;
    if (!this.fieldCells.group.visible) return;

    this.fieldCells.group.scale.setScalar(lerp(1.18, targetScale, reveal));
    const signalProgress = this.fieldSignalAge < 1.65
      ? clamp(this.fieldSignalAge / 1.5, 0, 1)
      : 2;
    const hands = this.snapshot.reticles
      .filter((reticle) => reticle.visibility > 0.6)
      .slice(0, 2);
    if (hands[0]) this.fieldHandA.set(hands[0].x * 2 - 1, -(hands[0].y * 2 - 1));
    else this.fieldHandA.set(99, 99);
    if (hands[1]) this.fieldHandB.set(hands[1].x * 2 - 1, -(hands[1].y * 2 - 1));
    else this.fieldHandB.set(99, 99);
    const cellTime = this.reducedMotion.matches ? elapsed * 0.25 : elapsed;
    this.fieldCells.materials.forEach((material) => {
      material.uniforms.uTime!.value = cellTime;
      material.uniforms.uUnfold!.value = reveal;
      material.uniforms.uSignalProgress!.value = signalProgress;
      (material.uniforms.uHandA!.value as THREE.Vector2).copy(this.fieldHandA);
      (material.uniforms.uHandB!.value as THREE.Vector2).copy(this.fieldHandB);
    });
  }

  private viewportWorldRadius(): number {
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * CAMERA_DISTANCE;
    return Math.hypot(halfHeight * this.camera.aspect, halfHeight);
  }

  private updateBurstWave(progress: number, presentedScale: number): void {
    this.burstWave.visible = progress < 1;
    if (!this.burstWave.visible) return;
    const eased = 1 - Math.pow(1 - progress, 3);
    this.burstWave.scale.setScalar(lerp(presentedScale * 1.08, 7.2, eased));
    this.burstWave.rotation.copy(this.currentRotation);
    this.burstWave.material.opacity = Math.pow(1 - progress, 1.65) * 0.2;
  }

  private trackFps(): void {
    const now = performance.now();
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((time) => now - time <= 1000);
    if (this.frameTimes.length % 15 === 0) this.onRenderFps?.(this.frameTimes.length);
  }

  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  private applyMotionPreference(): void {
    this.afterimage.enabled = !this.frozen && !this.reducedMotion.matches;
  }
}

function palette(
  core: [number, number, number],
  rim: [number, number, number],
  accent: [number, number, number],
  aura: [number, number, number],
  spark: [number, number, number],
  iridescence: number,
  hue: number,
): GesturePalette {
  return {
    core: new THREE.Color(...core),
    rim: new THREE.Color(...rim),
    accent: new THREE.Color(...accent),
    aura: new THREE.Color(...aura),
    spark: new THREE.Color(...spark),
    iridescence,
    hue,
  };
}

function paletteFor(mode: GestureMode): GesturePalette {
  if (mode === 'awake' || mode === 'release') return PALETTES.awake;
  if (mode === 'grab') return PALETTES.grab;
  if (mode === 'charge') return PALETTES.grab;
  if (
    mode === 'dual' ||
    mode === 'burst' ||
    mode === 'unfold-armed' ||
    mode === 'unfold' ||
    mode === 'expanded' ||
    mode === 'collapse'
  ) return PALETTES.dual;
  return PALETTES.ready;
}

function appearancePalette(color: THREE.Color): GesturePalette {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return {
    core: color.clone().multiplyScalar(0.09),
    rim: color.clone().multiplyScalar(0.52),
    accent: color.clone(),
    aura: color.clone().multiplyScalar(0.68),
    spark: color.clone().lerp(SOURCE_WHITE, 0.34),
    iridescence: 0.16,
    hue: hsl.h,
  };
}

function createFacetedGeometry(): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, 2);
  const geometry = base.index ? base.toNonIndexed() : base;
  if (geometry !== base) base.dispose();
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let triangle = 0; triangle < positions.count; triangle += 3) {
    const centerX = (positions.getX(triangle) + positions.getX(triangle + 1) + positions.getX(triangle + 2)) / 3;
    const centerY = (positions.getY(triangle) + positions.getY(triangle + 1) + positions.getY(triangle + 2)) / 3;
    const centerZ = (positions.getZ(triangle) + positions.getZ(triangle + 1) + positions.getZ(triangle + 2)) / 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle + corner;
      positions.setXYZ(
        vertex,
        centerX + (positions.getX(vertex) - centerX) * 0.91,
        centerY + (positions.getY(vertex) - centerY) * 0.91,
        centerZ + (positions.getZ(vertex) - centerZ) * 0.91,
      );
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  const vertexCount = geometry.getAttribute('position').count;
  const barycentric = new Float32Array(vertexCount * 3);
  const unfoldOffsets = new Float32Array(vertexCount * 3);
  const random = seededRandom(48271);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    barycentric[vertex * 3 + (vertex % 3)] = 1;
  }
  for (let triangle = 0; triangle < vertexCount; triangle += 3) {
    const center = new THREE.Vector3(
      (positions.getX(triangle) + positions.getX(triangle + 1) + positions.getX(triangle + 2)) / 3,
      (positions.getY(triangle) + positions.getY(triangle + 1) + positions.getY(triangle + 2)) / 3,
      (positions.getZ(triangle) + positions.getZ(triangle + 1) + positions.getZ(triangle + 2)) / 3,
    ).normalize();
    const axis = Math.abs(center.y) < 0.88
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3().crossVectors(center, axis).normalize();
    const bitangent = new THREE.Vector3().crossVectors(center, tangent).normalize();
    const offset = center
      .clone()
      .multiplyScalar(0.92 + random() * 0.92)
      .addScaledVector(tangent, (random() - 0.5) * 0.58)
      .addScaledVector(bitangent, (random() - 0.5) * 0.42);
    offset.z *= 0.38;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle + corner;
      unfoldOffsets[vertex * 3] = offset.x;
      unfoldOffsets[vertex * 3 + 1] = offset.y;
      unfoldOffsets[vertex * 3 + 2] = offset.z;
    }
  }
  geometry.setAttribute('aBarycentric', new THREE.BufferAttribute(barycentric, 3));
  geometry.setAttribute('aUnfoldOffset', new THREE.BufferAttribute(unfoldOffsets, 3));
  return geometry;
}

function createCageGeometry(): THREE.EdgesGeometry {
  const source = new THREE.IcosahedronGeometry(1, 2);
  const edges = new THREE.EdgesGeometry(source, 1);
  source.dispose();
  return edges;
}

function createFieldCellSamples(count: number): FieldCellSample[] {
  const source = new THREE.IcosahedronGeometry(1, 2);
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const directions: THREE.Vector3[] = [];
  for (let triangle = 0; triangle < positions.count; triangle += 3) {
    directions.push(new THREE.Vector3(
      (positions.getX(triangle) + positions.getX(triangle + 1) + positions.getX(triangle + 2)) / 3,
      (positions.getY(triangle) + positions.getY(triangle + 1) + positions.getY(triangle + 2)) / 3,
      (positions.getZ(triangle) + positions.getZ(triangle + 1) + positions.getZ(triangle + 2)) / 3,
    ).normalize());
  }
  geometry.dispose();

  const random = seededRandom(61031);
  for (let index = directions.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [directions[index], directions[target]] = [directions[target]!, directions[index]!];
  }

  const forward = new THREE.Vector3(0, 0, 1);
  return directions.slice(0, count).map((direction, index) => {
    const radius = 0.72 + (index % 3) * 0.17 + random() * 0.07;
    const quaternion = new THREE.Quaternion().setFromUnitVectors(forward, direction);
    quaternion.multiply(
      new THREE.Quaternion().setFromAxisAngle(forward, random() * Math.PI * 2),
    );
    return {
      position: direction.clone().multiplyScalar(radius),
      quaternion,
      scale: 0.105 + random() * 0.115,
      seed: random(),
      signal: clamp(0.08 + (radius - 0.72) * 1.55 + (random() - 0.5) * 0.08, 0.06, 0.9),
    };
  });
}

function createFieldNodeSamples(samples: FieldCellSample[]): FieldCellSample[] {
  const vertices = [
    new THREE.Vector3(0, 0.577, 0.002),
    new THREE.Vector3(-0.5, -0.289, 0.002),
    new THREE.Vector3(0.5, -0.289, 0.002),
  ];
  return samples.flatMap((sample) =>
    vertices.map((vertex, index) => ({
      position: sample.position.clone().add(
        vertex
          .clone()
          .multiplyScalar(sample.scale * 0.64)
          .applyQuaternion(sample.quaternion),
      ),
      quaternion: sample.quaternion.clone(),
      scale: sample.scale * 0.035,
      seed: positiveModulo(sample.seed + index * 0.19, 1),
      signal: sample.signal + index * 0.018,
    })),
  );
}

function createFieldInstances(
  geometry: THREE.BufferGeometry,
  material: THREE.ShaderMaterial,
  samples: FieldCellSample[],
  scaleMultiplier: number,
): THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const seeds = new Float32Array(samples.length);
  const signals = new Float32Array(samples.length);
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aSignal', new THREE.InstancedBufferAttribute(signals, 1));
  const mesh = new THREE.InstancedMesh(geometry, material, samples.length);
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  samples.forEach((sample, index) => {
    scale.setScalar(sample.scale * scaleMultiplier);
    matrix.compose(sample.position, sample.quaternion, scale);
    mesh.setMatrixAt(index, matrix);
    seeds[index] = sample.seed;
    signals[index] = sample.signal;
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.frustumCulled = false;
  return mesh;
}

function createTriangleFrameGeometry(inset: number): THREE.ShapeGeometry {
  const shape = triangleShape(1);
  const hole = new THREE.Path();
  const inner = trianglePoints(1 - inset);
  hole.moveTo(inner[0]!.x, inner[0]!.y);
  hole.lineTo(inner[2]!.x, inner[2]!.y);
  hole.lineTo(inner[1]!.x, inner[1]!.y);
  hole.closePath();
  shape.holes.push(hole);
  return new THREE.ShapeGeometry(shape);
}

function createTriangleFaceGeometry(): THREE.ShapeGeometry {
  return new THREE.ShapeGeometry(triangleShape(1));
}

function triangleShape(scale: number): THREE.Shape {
  const points = trianglePoints(scale);
  const shape = new THREE.Shape();
  shape.moveTo(points[0]!.x, points[0]!.y);
  shape.lineTo(points[1]!.x, points[1]!.y);
  shape.lineTo(points[2]!.x, points[2]!.y);
  shape.closePath();
  return shape;
}

function trianglePoints(scale: number): THREE.Vector2[] {
  return [
    new THREE.Vector2(0, 0.577 * scale),
    new THREE.Vector2(-0.5 * scale, -0.289 * scale),
    new THREE.Vector2(0.5 * scale, -0.289 * scale),
  ];
}

function idleSnapshot(): GestureSnapshot {
  return {
    timestamp: performance.now(),
    mode: 'ready',
    reticles: [],
    rotationDelta: { x: 0, y: 0 },
    scaleRatio: 1,
    rollDelta: 0,
    fieldControl: false,
    chargeLevel: 0,
    intensity: 0,
    trackingQuality: 0,
  };
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function setMaterialSide(material: THREE.Material, cameraIsInside: boolean): void {
  const side = cameraIsInside ? THREE.BackSide : THREE.FrontSide;
  if (material.side === side) return;
  material.side = side;
  material.needsUpdate = true;
}
