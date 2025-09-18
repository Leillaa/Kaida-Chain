// main.js � �������� ����� ��� ����� A > B
import * as THREE from "https://unpkg.com/three@0.158.0/build/three.module.js";

const ASSET_A = new URL("./assets/A.svg", import.meta.url).href;
const ASSET_B = new URL("./assets/B.svg", import.meta.url).href;

const BG_COLOR      = 0x02030a;
const GRAIN_COLOR   = 0x33d8ff;

const PARTICLES     = 15000;
const SAMPLE_SIZE   = 512;
const SAMPLE_STEP   = 2;
const ALPHA_THR     = 6;
const JITTER_PX     = 0.85;
const CANVAS_SCALE  = 0.96; // ���� ������ 1, ����� �������� ����

const POINT_SIZE    = 0.015;
const SPREAD        = 0.26;
const DUST_RATIO    = 0.12;
const STRAY_PARTICLES = 0;
const MORPH_START_RATIO = 0.72;
const MORPH_RANGE_RATIO = 0.5;
const MORPH_START_Y  = -0.4;
const MORPH_END_Y    = 1.8;
const STRAY_FOLLOW   = 0.24;
const MORPH_DROP_Y  = -1.2;
const SCROLL_SMOOTH  = 2.6;
const MORPH_SMOOTH   = 2.4;

const SCROLL_START  = 0;
const SCROLL_RANGE  = 2.4 * innerHeight;

const canvas = document.getElementById("bg");
const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, alpha:false, powerPreference:"high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(BG_COLOR, 1);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 100);
camera.position.z = 3.2;

const clamp01 = x => Math.max(0, Math.min(1, x));
const easeOut = t => 1 - Math.pow(1 - t, 3);
const lerp = (a,b,t) => a + (b - a) * t;

function loadImage(src){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image: " + src));
    img.src = src;
  });
}

function buildAlphaBuffer(data){
  const alpha = new Uint8Array(data.length/4);
  for (let i=0, p=0; i<data.length; i+=4, p++) alpha[p] = data[i+3];
  return alpha;
}

function maxAlphaInNeighborhood(alpha, size, xx, yy){
  let max = 0;
  for (let oy=-1; oy<=1; oy++){
    const sy = yy + oy;
    if (sy < 0 || sy >= size) continue;
    for (let ox=-1; ox<=1; ox++){
      const sx = xx + ox;
      if (sx < 0 || sx >= size) continue;
      const v = alpha[sy*size + sx];
      if (v > max) max = v;
    }
  }
  return max;
}

function transformPoints(buffer, { scale=1, offset=[0,0,0] } = {}){
  const sx = Array.isArray(scale) ? (scale[0] ?? 1) : scale;
  const sy = Array.isArray(scale) ? (scale[1] ?? scale[0] ?? 1) : scale;
  const sz = Array.isArray(scale) ? (scale[2] ?? scale[1] ?? scale[0] ?? 1) : scale;
  const ox = offset[0] ?? 0;
  const oy = offset[1] ?? 0;
  const oz = offset[2] ?? 0;
  for (let i=0; i<buffer.length; i+=3){
    buffer[i]   = buffer[i]   * sx + ox;
    buffer[i+1] = buffer[i+1] * sy + oy;
    buffer[i+2] = buffer[i+2] * sz + oz;
  }
  return buffer;
}

async function sampleShapeToPoints(img, targetCount, {
  size = SAMPLE_SIZE,
  step = SAMPLE_STEP,
  alphaThr = ALPHA_THR,
  jitterPx = JITTER_PX,
  scale = CANVAS_SCALE
} = {}){
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const r = Math.min(size/img.width, size/img.height);
  const w = Math.max(1, Math.round(img.width * r));
  const h = Math.max(1, Math.round(img.height * r));
  const x = Math.floor((size - w) / 2);
  const y = Math.floor((size - h) / 2);

  ctx.clearRect(0,0,size,size);
  ctx.drawImage(img, x, y, w, h);

  const { data } = ctx.getImageData(0,0,size,size);
  const alpha = buildAlphaBuffer(data);

  const pts = [];
  const jitter = () => (Math.random()*2 - 1) * jitterPx;

  for (let yy=0; yy<size; yy+=step){
    for (let xx=0; xx<size; xx+=step){
      if (maxAlphaInNeighborhood(alpha, size, xx, yy) <= alphaThr) continue;

      const px = Math.min(size-1, Math.max(0, xx + jitter()));
      const py = Math.min(size-1, Math.max(0, yy + jitter()));
      const nx = (px/size)*2 - 1;
      const ny = 1 - (py/size)*2;
      pts.push(nx*scale, ny*scale, 0);
    }
  }

  if (pts.length === 0) return new Float32Array(targetCount*3);

  const out = new Float32Array(targetCount*3);
  const srcCount = pts.length/3;
  for (let i=0; i<targetCount; i++){
    const j = (i % srcCount) * 3;
    out[i*3]   = pts[j];
    out[i*3+1] = pts[j+1];
    out[i*3+2] = pts[j+2];
  }
  return out;
}

const vert = /* glsl */`
attribute vec3 aTarget;
attribute float aRand;
varying float vRand;
uniform float uTime, uProgress, uSpread, uDustRatio;

vec3 flow(vec3 p, float r){
  float t = uTime*0.6 + r*10.0;
  return vec3(
    sin(p.y*1.25 + t),
    sin(p.x*1.20 + t*1.05),
    sin(p.y*1.10 + t*0.95)
  ) * 0.14;
}

void main(){
  float p = smoothstep(0.0, 1.0, uProgress);
  vec3 pos = mix(position, aTarget, p);

  float grainRnd = fract(sin(aRand * 43758.5453) * 43758.5453);
  vRand = grainRnd;
  float sizeJitter = mix(0.65, 1.25, grainRnd);

  float explode = sin(p * 3.14159265);
  float dust    = step(1.0 - uDustRatio, aRand);
  pos += flow(pos, aRand) * uSpread * explode;
  pos += dust * flow(pos * 1.7, aRand * 1.3) * uSpread * 1.6 * explode;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = ${POINT_SIZE.toFixed(3)} * sizeJitter * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */`
precision mediump float;
uniform vec3 uColor;
varying float vRand;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.48, 0.30, 0.5 - d);
  if (a <= 0.0) discard;
  float sparkle = fract(sin(vRand * 91.7) * 43758.5453);
  float shade = mix(0.78, 1.08, sparkle);
  float alpha = a * mix(0.65, 1.0, sparkle);
  gl_FragColor = vec4(uColor * shade, alpha);
}`;

(async function init(){
  console.clear();

  const [imgA, imgB] = await Promise.all([
    loadImage(ASSET_A),
    loadImage(ASSET_B)
  ]);

  const posA = await sampleShapeToPoints(imgA, PARTICLES);
  const posB = await sampleShapeToPoints(imgB, PARTICLES);
  transformPoints(posA, { offset:[0, 0, 0] });
  transformPoints(posB, { scale:0.78, offset:[-1.1, -1, 0] });
  console.log("[morph] A points:", posA.length/3, "B points:", posB.length/3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(posA, 3));
  geometry.setAttribute("aTarget",  new THREE.BufferAttribute(posB, 3));

  const rand = new Float32Array(PARTICLES);
  for (let i=0; i<PARTICLES; i++) rand[i] = Math.random();
  geometry.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime:      { value: 0 },
      uProgress:  { value: 0 },
      uSpread:    { value: SPREAD },
      uDustRatio: { value: DUST_RATIO },
      uColor:     { value: new THREE.Color(GRAIN_COLOR) }
    },
    vertexShader: vert,
    fragmentShader: frag
  });




  const points = new THREE.Points(geometry, material);
  points.position.y = MORPH_START_Y;
  scene.add(points);

  let scrollFiltered = 0;
  let morphFiltered = 0;
  let prev = performance.now();
  function tick(now){
    const dtMs = now - prev;
    prev = now;
    const dt = Math.max(0.0001, dtMs * 0.001);

    const targetScroll = clamp01((scrollY - SCROLL_START) / SCROLL_RANGE);
    const scrollEase = 1 - Math.exp(-SCROLL_SMOOTH * dt);
    scrollFiltered += (targetScroll - scrollFiltered) * scrollEase;

    let targetMorph = (targetScroll - MORPH_START_RATIO) / Math.max(0.0001, MORPH_RANGE_RATIO);
    targetMorph = clamp01(targetMorph);
    const morphEase = 1 - Math.exp(-MORPH_SMOOTH * dt);
    morphFiltered += (targetMorph - morphFiltered) * morphEase;

    const easedMorph = easeOut(morphFiltered);
    if (easedMorph > 0.001 && easedMorph < 0.999) {
      material.uniforms.uTime.value += dt;
    }
    material.uniforms.uProgress.value = easedMorph;

    const baseY = lerp(MORPH_START_Y, MORPH_END_Y, scrollFiltered);
    const dropY = lerp(0, MORPH_DROP_Y, easedMorph);
    points.position.y = baseY + dropY;

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

addEventListener("resize", ()=>{
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
































