"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { type Agent, type AgentStatus, herdr, repoName } from "@/lib/herdr";
import { useAgents } from "@/components/use-agents";
import { makeLabelTexture, isHebrew } from "@/components/office/text-texture";

// ─────────────────────────────────────────────────────────────────────────────
// herdr 3D Office FPS — single-file scene.
// Each live agent = one cubicle keyed by workspace_id with a stable slot.
// Pointer-lock FPS: WASD + jump/sprint/crouch, hitscan gun, 3 shots kill an
// agent (real herdr.kill), the focused controller agent is shield-protected.
// All textures Canvas2D, all audio WebAudio synth. No addons, no external assets.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS: Record<AgentStatus, { c: number; i: number }> = {
  working: { c: 0x33ddff, i: 2.2 },
  idle: { c: 0xffaa44, i: 0.5 },
  blocked: { c: 0xff3322, i: 1.6 },
  done: { c: 0x44ff88, i: 1.4 },
  unknown: { c: 0x8899aa, i: 0.7 },
};

const STATUS_HEX: Record<AgentStatus, string> = {
  working: "#33ddff",
  idle: "#ffaa44",
  blocked: "#ff3322",
  done: "#44ff88",
  unknown: "#8899aa",
};

// The backend produces agent_status from untyped CLI JSON with no runtime
// validation, so the AgentStatus type is a compile-time fiction. Normalize any
// out-of-union / missing value to "unknown" before indexing STATUS/STATUS_HEX.
const safeStatus = (s: AgentStatus): AgentStatus =>
  s in STATUS ? s : "unknown";

const COLS = 5;
const MAX_DESKS = 20;
const CELL = 5.2;
const ROW_GAP = 6.4;
const EYE = 1.62;
const CROUCH_EYE = 1.05;
const MAG_SIZE = 12;
const RESERVE_MAX = 96;
const HITS_TO_KILL = 3;

interface HudState {
  health: number;
  stamina: number;
  ammo: number;
  reserve: number;
  reloading: boolean;
  score: number;
  combo: number;
  killfeed: { id: number; text: string; color: string }[];
  objective: string;
  fps: number;
  hitmarker: number;
  headshot: boolean;
  damageFlash: number;
  killFlash: number;
  shieldHint: number;
  paused: boolean;
  locked: boolean;
  connected: boolean;
  error: string | null;
  highScore: number;
  spread: number;
}

interface Rig {
  group: THREE.Group;
  monitorMat: THREE.MeshStandardMaterial;
  light: THREE.PointLight;
  bloom: THREE.Sprite;
  head: THREE.Mesh;
  body: THREE.Mesh;
  torso: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  chair: THREE.Group;
  sign?: THREE.Sprite;
  signTex?: THREE.CanvasTexture;
  bubble?: THREE.Sprite;
  bubbleTex?: THREE.CanvasTexture;
  status: AgentStatus;
  targetColor: THREE.Color;
  targetIntensity: number;
  paneId: string;
  focused: boolean;
  seed: number;
  slot: number;
  dead: boolean;
  deathT: number;
  signText: string;
}

export function OfficeScene() {
  const { agents, connected, error } = useAgents();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const agentsRef = useRef<Agent[]>([]);
  agentsRef.current = agents;

  const [hud, setHud] = useState<HudState>({
    health: 100,
    stamina: 100,
    ammo: MAG_SIZE,
    reserve: RESERVE_MAX,
    reloading: false,
    score: 0,
    combo: 1,
    killfeed: [],
    objective: "Eliminate idle/blocked agents — protect the controller",
    fps: 0,
    hitmarker: 0,
    headshot: false,
    damageFlash: 0,
    killFlash: 0,
    shieldHint: 0,
    paused: false,
    locked: false,
    connected: false,
    error: null,
    highScore: 0,
    spread: 6,
  });

  useEffect(() => {
    setHud((h) => ({ ...h, connected, error }));
  }, [connected, error]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ── HUD push throttle ────────────────────────────────────────────────────
    let hudDirty = true;
    const hudData: HudState = {
      health: 100,
      stamina: 100,
      ammo: MAG_SIZE,
      reserve: RESERVE_MAX,
      reloading: false,
      score: 0,
      combo: 1,
      killfeed: [],
      objective: "Eliminate idle/blocked agents — protect the controller",
      fps: 0,
      hitmarker: 0,
      headshot: false,
      damageFlash: 0,
      killFlash: 0,
      shieldHint: 0,
      paused: false,
      locked: false,
      connected: false,
      error: null,
      highScore: 0,
      spread: 6,
    };
    const pushHud = (patch: Partial<HudState>) => {
      Object.assign(hudData, patch);
      hudDirty = true;
    };

    // ── THREE bootstrap ──────────────────────────────────────────────────────
    THREE.ColorManagement.enabled = true;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x12141f, 0.011);

    const camera = new THREE.PerspectiveCamera(
      72,
      mount.clientWidth / mount.clientHeight,
      0.05,
      400,
    );

    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // ── Room bounds (computed from grid) ─────────────────────────────────────
    const rows = Math.ceil(MAX_DESKS / COLS);
    const gridW = (COLS - 1) * CELL;
    const gridD = (rows - 1) * ROW_GAP;
    const ROOM_W = gridW + 12;
    const halfW = ROOM_W / 2;
    const minZ = -6;
    const maxZ = gridD + 8;
    const ROOM_H = 4.4;

    const slotPos = (slot: number): THREE.Vector3 => {
      const col = slot % COLS;
      const row = Math.floor(slot / COLS);
      const x = (col - (COLS - 1) / 2) * CELL;
      const z = row * ROW_GAP;
      return new THREE.Vector3(x, 0, z);
    };

    // ── Shared Canvas2D textures ─────────────────────────────────────────────
    function carpetTexture(): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#2a2f48";
      ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 5000; i++) {
        const v = 40 + Math.random() * 34;
        ctx.fillStyle = `rgb(${v * 0.75},${v * 0.82},${v + 14})`;
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
      ctx.strokeStyle = "rgba(110,140,190,0.12)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 256; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 256);
        ctx.moveTo(0, i);
        ctx.lineTo(256, i);
        ctx.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    function skylineTexture(): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = 2048;
      c.height = 512;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#0a0a18";
      ctx.fillRect(0, 0, 2048, 512);
      const bandY = 150;
      const bandH = 230;
      const g = ctx.createLinearGradient(0, bandY, 0, bandY + bandH);
      g.addColorStop(0, "#1a1240");
      g.addColorStop(0.55, "#2a1455");
      g.addColorStop(1, "#451252");
      ctx.fillStyle = g;
      ctx.fillRect(0, bandY, 2048, bandH);
      for (let i = 0; i < 60; i++) {
        const bw = 30 + Math.random() * 70;
        const bx = Math.random() * 2048;
        const bh = 60 + Math.random() * (bandH - 20);
        ctx.fillStyle = "#0c0a22";
        ctx.fillRect(bx, bandY + bandH - bh, bw, bh);
        for (let wy = bandY + bandH - bh + 6; wy < bandY + bandH - 4; wy += 9) {
          for (let wx = bx + 4; wx < bx + bw - 4; wx += 8) {
            if (Math.random() < 0.45) {
              ctx.fillStyle =
                Math.random() < 0.6
                  ? "rgba(255,210,120,0.9)"
                  : "rgba(120,220,255,0.85)";
              ctx.fillRect(wx, wy, 4, 5);
            }
          }
        }
      }
      ctx.strokeStyle = "#05050d";
      ctx.lineWidth = 8;
      for (let x = 0; x <= 2048; x += 170) {
        ctx.beginPath();
        ctx.moveTo(x, bandY);
        ctx.lineTo(x, bandY + bandH);
        ctx.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    function whiteboardTexture(): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 320;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#f4f5f7";
      ctx.fillRect(0, 0, 512, 320);
      const cols = ["#2563eb", "#dc2626", "#16a34a", "#7c3aed"];
      for (let i = 0; i < 9; i++) {
        ctx.strokeStyle = cols[i % cols.length];
        ctx.lineWidth = 2 + Math.random() * 3;
        ctx.beginPath();
        let x = 30 + Math.random() * 100;
        let y = 30 + Math.random() * 260;
        ctx.moveTo(x, y);
        for (let k = 0; k < 5; k++) {
          x += 40 + Math.random() * 60;
          y += (Math.random() - 0.5) * 80;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = "#111";
      ctx.font = "bold 30px sans-serif";
      ctx.fillText("SPRINT", 30, 50);
      ctx.font = "20px sans-serif";
      ctx.fillText("ship it", 320, 290);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    function neonHerdrTexture(): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = 1024;
      c.height = 256;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, 1024, 256);
      ctx.font = "bold 170px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "#22d3ee";
      ctx.shadowBlur = 40;
      ctx.fillStyle = "#a5f3fc";
      ctx.fillText("herdr", 512, 138);
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#ecfeff";
      ctx.fillText("herdr", 512, 138);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    function posterTexture(
      bg: string,
      accent: string,
      title: string,
      sub: string,
    ): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 768;
      const ctx = c.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, 0, 768);
      g.addColorStop(0, bg);
      g.addColorStop(1, "#0b0d18");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 768);
      // accent geometry
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(256, 300, 150, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#0b0d18";
      ctx.beginPath();
      ctx.arc(256, 300, 110, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.font = "bold 90px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, 256, 300);
      ctx.fillStyle = "#e8ecf6";
      ctx.font = "bold 48px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(sub, 256, 560);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, 498, 754);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    // Scrolling code monitor texture (shared, redrawn ~18fps).
    const codeCanvas = document.createElement("canvas");
    codeCanvas.width = 256;
    codeCanvas.height = 256;
    const codeCtx = codeCanvas.getContext("2d")!;
    const codeTex = track(new THREE.CanvasTexture(codeCanvas));
    codeTex.colorSpace = THREE.SRGBColorSpace;
    let codeScroll = 0;
    const codeLines: string[] = [];
    {
      const toks = [
        "const ",
        "let ",
        "return ",
        "await herdr.",
        "function ",
        "if (status",
        "  scene.add(",
        "render()",
        "  // TODO",
        "import * as",
        "for (let i",
        "=> {",
        "} catch (e)",
        "this.update(",
        "  paneId,",
      ];
      for (let i = 0; i < 40; i++) {
        let s = "";
        const n = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n; k++)
          s += toks[Math.floor(Math.random() * toks.length)];
        codeLines.push(s.slice(0, 30));
      }
    }
    const drawCode = () => {
      codeCtx.fillStyle = "#04060e";
      codeCtx.fillRect(0, 0, 256, 256);
      codeCtx.font = "11px monospace";
      const lh = 13;
      const off = codeScroll % lh;
      for (let i = -1; i < 256 / lh + 1; i++) {
        const idx =
          (Math.floor(codeScroll / lh) + i + codeLines.length * 4) %
          codeLines.length;
        const li = codeLines[idx];
        const y = i * lh - off + 12;
        codeCtx.fillStyle = i % 5 === 0 ? "#7dd3fc" : "#3b82f6";
        codeCtx.fillText(li, 6, y);
      }
      codeTex.needsUpdate = true;
    };
    drawCode();

    function bloomTexture(): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const ctx = c.getContext("2d")!;
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.25, "rgba(255,255,255,0.7)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    function ringTexture(): THREE.CanvasTexture {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const ctx = c.getContext("2d")!;
      ctx.strokeStyle = "rgba(255,255,255,1)";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(64, 64, 50, 0, Math.PI * 2);
      ctx.stroke();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }

    const carpetTex = track(carpetTexture());
    carpetTex.repeat.set(ROOM_W / 2, (maxZ - minZ) / 2);
    const skyTex = track(skylineTexture());
    scene.background = skyTex;
    const wbTex = track(whiteboardTexture());
    const neonTex = track(neonHerdrTexture());
    const bloomTex = track(bloomTexture());
    const ringTex = track(ringTexture());

    const bloomMat = track(
      new THREE.SpriteMaterial({
        map: bloomTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        color: 0xffffff,
      }),
    );
    const makeBloom = (color: number, scale: number, opacity: number) => {
      const m = bloomMat.clone();
      m.color = new THREE.Color(color);
      m.opacity = opacity;
      const s = new THREE.Sprite(m);
      s.scale.setScalar(scale);
      return s;
    };

    // ── Lighting ─────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x4e608a, 1.45));
    scene.add(new THREE.HemisphereLight(0x728ab8, 0x2a2238, 1.2));

    const panelPositions = [
      new THREE.Vector3(-halfW * 0.45, ROOM_H - 0.2, gridD * 0.25),
      new THREE.Vector3(halfW * 0.45, ROOM_H - 0.2, gridD * 0.25),
      new THREE.Vector3(-halfW * 0.45, ROOM_H - 0.2, gridD * 0.75),
      new THREE.Vector3(halfW * 0.45, ROOM_H - 0.2, gridD * 0.75),
    ];
    panelPositions.forEach((p, i) => {
      const sp = new THREE.SpotLight(0xcfe0ff, 2.9, 28, Math.PI / 3.2, 0.5, 1.2);
      sp.position.copy(p);
      sp.target.position.set(p.x, 0, p.z);
      sp.castShadow = i < 2;
      if (sp.castShadow) {
        sp.shadow.mapSize.set(1024, 1024);
        sp.shadow.camera.near = 0.5;
        sp.shadow.camera.far = 26;
        sp.shadow.bias = -0.0005;
      }
      scene.add(sp);
      scene.add(sp.target);
    });

    // ── Materials (shared) ───────────────────────────────────────────────────
    const floorMat = track(
      new THREE.MeshStandardMaterial({
        map: carpetTex,
        roughness: 0.95,
        metalness: 0.0,
      }),
    );
    const wallMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x3c4666,
        emissive: 0x14182a,
        emissiveIntensity: 0.5,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.BackSide,
      }),
    );
    const windowWallMat = track(
      new THREE.MeshStandardMaterial({
        map: skyTex,
        emissiveMap: skyTex,
        emissive: 0xffffff,
        emissiveIntensity: 0.6,
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.BackSide,
      }),
    );
    const ceilMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x222842,
        emissive: 0x0e1120,
        emissiveIntensity: 0.4,
        roughness: 0.95,
        side: THREE.BackSide,
      }),
    );
    const deskMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x3a2e26,
        roughness: 0.6,
        metalness: 0.15,
      }),
    );
    const metalMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x55606e,
        roughness: 0.35,
        metalness: 0.7,
      }),
    );
    const chairMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x1c1f2b,
        roughness: 0.7,
        metalness: 0.2,
      }),
    );
    const skinMat = track(
      new THREE.MeshStandardMaterial({ color: 0xd6a07a, roughness: 0.7 }),
    );
    const partitionMat = track(
      new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.85 }),
    );

    // ── Static geometry ──────────────────────────────────────────────────────
    const cz = (minZ + maxZ) / 2;
    const dimZ = maxZ - minZ;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, dimZ), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, cz);
    floor.receiveShadow = true;
    scene.add(floor);

    const shellGeo = new THREE.BoxGeometry(ROOM_W, ROOM_H, dimZ);
    const shell = new THREE.Mesh(shellGeo, wallMat);
    shell.position.set(0, ROOM_H / 2, cz);
    scene.add(shell);

    const ceilGeo = new THREE.PlaneGeometry(ROOM_W, dimZ);
    const ceil = new THREE.Mesh(ceilGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, ROOM_H, cz);
    scene.add(ceil);

    const backWallGeo = new THREE.PlaneGeometry(ROOM_W - 0.4, ROOM_H - 0.4);
    const backWall = new THREE.Mesh(backWallGeo, windowWallMat);
    backWall.position.set(0, ROOM_H / 2, maxZ - 0.05);
    backWall.rotation.y = Math.PI;
    scene.add(backWall);

    const neonMat = track(
      new THREE.MeshBasicMaterial({
        map: neonTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const neonGeo = new THREE.PlaneGeometry(6, 1.5);
    const neon = new THREE.Mesh(neonGeo, neonMat);
    neon.position.set(0, 3.4, maxZ - 0.12);
    neon.rotation.y = Math.PI;
    scene.add(neon);
    const neonBloom = makeBloom(0x22d3ee, 7, 0.5);
    neonBloom.position.set(0, 3.4, maxZ - 0.4);
    scene.add(neonBloom);

    const panelGeo = new THREE.PlaneGeometry(2.6, 1.4);
    const panelMat = track(new THREE.MeshBasicMaterial({ color: 0xbfd4ff }));
    const panelBlooms: THREE.Sprite[] = [];
    panelPositions.forEach((p) => {
      const pm = new THREE.Mesh(panelGeo, panelMat);
      pm.rotation.x = Math.PI / 2;
      pm.position.set(p.x, ROOM_H - 0.02, p.z);
      scene.add(pm);
      const b = makeBloom(0xbfd4ff, 4, 0.3);
      b.position.set(p.x, ROOM_H - 0.3, p.z);
      scene.add(b);
      panelBlooms.push(b);
    });

    // ── Fluorescent ceiling tubes (shootable, some flicker) ──────────────────
    interface Fluoro {
      group: THREE.Group;
      tubeMat: THREE.MeshBasicMaterial;
      light: THREE.PointLight;
      bloom: THREE.Sprite;
      broken: boolean;
      alive: boolean;
      seed: number;
      baseI: number;
    }
    const fluoros: Fluoro[] = [];
    const fluoroTargets: THREE.Mesh[] = [];
    const fixtureMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xc8ccd4,
        roughness: 0.5,
        metalness: 0.6,
      }),
    );
    const fluoroHitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
    const housingGeo = new THREE.BoxGeometry(2.7, 0.13, 0.66);
    const tubeGeo = new THREE.BoxGeometry(2.4, 0.07, 0.13);
    const fluoroHitGeo = new THREE.BoxGeometry(2.9, 0.5, 0.85);
    const fluoroSpots: { x: number; z: number; broken?: boolean }[] = [
      { x: -5.8, z: 0 },
      { x: 5.8, z: 0 },
      { x: -5.8, z: gridD * 0.34, broken: true },
      { x: 5.8, z: gridD * 0.34 },
      { x: -5.8, z: gridD * 0.67 },
      { x: 5.8, z: gridD * 0.67, broken: true },
      { x: -5.8, z: gridD },
      { x: 5.8, z: gridD },
    ];
    const fluoroY = ROOM_H - 0.09;
    fluoroSpots.forEach((sp, idx) => {
      const g = new THREE.Group();
      g.position.set(sp.x, fluoroY, sp.z);

      const housing = new THREE.Mesh(housingGeo, fixtureMat);
      g.add(housing);

      const tubeMat = track(
        new THREE.MeshBasicMaterial({ color: 0xeaf2ff, toneMapped: false }),
      );
      for (const tz of [-0.16, 0.16]) {
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.position.set(0, -0.06, tz);
        g.add(tube);
      }

      const light = new THREE.PointLight(0xdfeaff, 2.7, 16, 1.5);
      light.position.set(0, -0.35, 0);
      g.add(light);

      const bloom = makeBloom(0xdfeaff, 3.4, 0.5);
      bloom.position.set(0, -0.4, 0);
      g.add(bloom);

      const hit = new THREE.Mesh(fluoroHitGeo, fluoroHitMat);
      hit.position.set(0, -0.18, 0);
      hit.userData = { fluoro: idx };
      g.add(hit);

      scene.add(g);
      fluoros.push({
        group: g,
        tubeMat,
        light,
        bloom,
        broken: !!sp.broken,
        alive: true,
        seed: Math.random() * 100,
        baseI: 2.7,
      });
      fluoroTargets.push(hit);
    });

    const wbMat = track(
      new THREE.MeshStandardMaterial({ map: wbTex, roughness: 0.5 }),
    );
    const wbGeo = new THREE.PlaneGeometry(2.6, 1.6);
    [-1, 1].forEach((side, i) => {
      const wb = new THREE.Mesh(wbGeo, wbMat);
      wb.position.set(side * (halfW - 0.1), 2.2, gridD * 0.3 + i * 4);
      wb.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      scene.add(wb);
    });

    // ── Potted plants (instanced) ────────────────────────────────────────────
    const plantSpots: THREE.Vector3[] = [
      new THREE.Vector3(-halfW + 1, 0, minZ + 1.2),
      new THREE.Vector3(halfW - 1, 0, minZ + 1.2),
      new THREE.Vector3(-halfW + 1, 0, gridD * 0.28),
      new THREE.Vector3(halfW - 1, 0, gridD * 0.28),
      new THREE.Vector3(-halfW + 1, 0, gridD * 0.5),
      new THREE.Vector3(halfW - 1, 0, gridD * 0.5),
      new THREE.Vector3(-halfW + 1, 0, gridD * 0.75),
      new THREE.Vector3(halfW - 1, 0, gridD * 0.75),
      new THREE.Vector3(-halfW + 1, 0, maxZ - 2),
      new THREE.Vector3(halfW - 1, 0, maxZ - 2),
    ];
    const potGeo = new THREE.CylinderGeometry(0.28, 0.22, 0.45, 10);
    const potMat = track(
      new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.8 }),
    );
    const leafGeo = new THREE.ConeGeometry(0.45, 1.1, 8);
    const leafMat = track(
      new THREE.MeshStandardMaterial({ color: 0x2f7d4f, roughness: 0.8 }),
    );
    const potInst = new THREE.InstancedMesh(potGeo, potMat, plantSpots.length);
    const leafInst = new THREE.InstancedMesh(leafGeo, leafMat, plantSpots.length);
    const dummy = new THREE.Object3D();
    plantSpots.forEach((p, i) => {
      dummy.position.set(p.x, 0.22, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      potInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, 1.0, p.z);
      dummy.updateMatrix();
      leafInst.setMatrixAt(i, dummy.matrix);
    });
    potInst.instanceMatrix.needsUpdate = true;
    leafInst.instanceMatrix.needsUpdate = true;
    scene.add(potInst);
    scene.add(leafInst);

    // ── Server racks with blinking LEDs (instanced) ──────────────────────────
    const rackGroup = new THREE.Group();
    const rackGeo = new THREE.BoxGeometry(0.9, 2.6, 0.7);
    const rackMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x14161f,
        roughness: 0.4,
        metalness: 0.6,
      }),
    );
    const rackSpots = [
      new THREE.Vector3(-halfW + 1.2, 1.3, maxZ - 2),
      new THREE.Vector3(-halfW + 2.3, 1.3, maxZ - 2),
      new THREE.Vector3(halfW - 1.2, 1.3, maxZ - 2),
      new THREE.Vector3(halfW - 2.3, 1.3, maxZ - 2),
    ];
    rackSpots.forEach((p) => {
      const r = new THREE.Mesh(rackGeo, rackMat);
      r.position.copy(p);
      rackGroup.add(r);
    });
    scene.add(rackGroup);

    const LED_PER_RACK = 18;
    const ledCount = rackSpots.length * LED_PER_RACK;
    const ledGeo = new THREE.BoxGeometry(0.06, 0.06, 0.03);
    const ledMat = track(
      new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    );
    const ledInst = new THREE.InstancedMesh(ledGeo, ledMat, ledCount);
    const ledColors = new Float32Array(ledCount * 3);
    const ledColor = new THREE.Color();
    let li = 0;
    rackSpots.forEach((p) => {
      for (let k = 0; k < LED_PER_RACK; k++) {
        const row = k % 9;
        const coli = k < 9 ? 0 : 1;
        dummy.position.set(
          p.x - 0.3 + coli * 0.6,
          p.y + 1.0 - row * 0.26,
          p.z + 0.36,
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        ledInst.setMatrixAt(li, dummy.matrix);
        ledColor.setHSL(Math.random(), 0.9, 0.5);
        ledColor.toArray(ledColors, li * 3);
        li++;
      }
    });
    ledInst.instanceMatrix.needsUpdate = true;
    ledInst.instanceColor = new THREE.InstancedBufferAttribute(ledColors, 3);
    scene.add(ledInst);

    // ── Partitions between cubicles (instanced) ──────────────────────────────
    const partGeo = new THREE.BoxGeometry(0.08, 1.3, 3.6);
    const partCount = (COLS + 1) * rows;
    const partInst = new THREE.InstancedMesh(partGeo, partitionMat, partCount);
    let pi = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c <= COLS; c++) {
        const x = (c - COLS / 2) * CELL;
        const z = r * ROW_GAP - 0.3;
        dummy.position.set(x, 0.85, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        partInst.setMatrixAt(pi++, dummy.matrix);
      }
    }
    partInst.instanceMatrix.needsUpdate = true;
    scene.add(partInst);

    // ── Decor: filing cabinets, water cooler, wall clock ─────────────────────
    const decor = new THREE.Group();

    // Filing cabinets lined along the side walls
    const cabBodyGeo = new THREE.BoxGeometry(0.8, 1.3, 0.6);
    const cabBodyMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x6b7280,
        roughness: 0.5,
        metalness: 0.5,
      }),
    );
    const drawerGeo = new THREE.BoxGeometry(0.7, 0.34, 0.04);
    const drawerMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x515a66,
        roughness: 0.5,
        metalness: 0.55,
      }),
    );
    const handleGeo = new THREE.BoxGeometry(0.22, 0.04, 0.03);
    const cabSpots: [number, number][] = [
      [-halfW + 0.6, minZ + 3.2],
      [-halfW + 0.6, minZ + 4.2],
      [halfW - 0.6, minZ + 3.2],
      [halfW - 0.6, minZ + 4.2],
    ];
    cabSpots.forEach(([x, z]) => {
      const cab = new THREE.Mesh(cabBodyGeo, cabBodyMat);
      cab.position.set(x, 0.65, z);
      cab.castShadow = true;
      decor.add(cab);
      const faceX = x < 0 ? 0.31 : -0.31;
      for (let d = 0; d < 3; d++) {
        const drawer = new THREE.Mesh(drawerGeo, drawerMat);
        drawer.position.set(x + faceX, 0.32 + d * 0.4, z);
        drawer.rotation.y = Math.PI / 2;
        decor.add(drawer);
        const handle = new THREE.Mesh(handleGeo, metalMat);
        handle.position.set(x + faceX + (x < 0 ? 0.02 : -0.02), 0.32 + d * 0.4, z);
        handle.rotation.y = Math.PI / 2;
        decor.add(handle);
      }
    });

    // Water cooler near the entrance
    const coolerBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 1.0, 0.45),
      track(
        new THREE.MeshStandardMaterial({
          color: 0xe8edf2,
          roughness: 0.4,
          metalness: 0.1,
        }),
      ),
    );
    coolerBase.position.set(halfW - 0.7, 0.5, minZ + 1.4);
    coolerBase.castShadow = true;
    decor.add(coolerBase);
    const bottle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.18, 0.55, 14),
      track(
        new THREE.MeshStandardMaterial({
          color: 0x4aa8e0,
          roughness: 0.1,
          metalness: 0.0,
          transparent: true,
          opacity: 0.55,
        }),
      ),
    );
    bottle.position.set(halfW - 0.7, 1.28, minZ + 1.4);
    decor.add(bottle);

    // Wall clock on the back wall
    const clockBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.07, 28),
      track(
        new THREE.MeshStandardMaterial({ color: 0xf4f6fa, roughness: 0.4 }),
      ),
    );
    clockBody.rotation.x = Math.PI / 2;
    clockBody.position.set(-halfW * 0.5, ROOM_H - 1.1, maxZ - 0.2);
    decor.add(clockBody);
    const clockGroup = new THREE.Group();
    clockGroup.position.copy(clockBody.position);
    clockGroup.position.z -= 0.05;
    const handMat = track(new THREE.MeshBasicMaterial({ color: 0x111418 }));
    const hourHand = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.22, 0.01),
      handMat,
    );
    hourHand.position.y = 0.09;
    const minHand = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.32, 0.01),
      handMat,
    );
    minHand.position.y = 0.14;
    const hourPivot = new THREE.Group();
    hourPivot.add(hourHand);
    hourPivot.rotation.z = -1.2;
    const minPivot = new THREE.Group();
    minPivot.add(minHand);
    minPivot.rotation.z = 2.4;
    clockGroup.add(hourPivot, minPivot);
    decor.add(clockGroup);

    // Ceiling air ducts running the length of the room
    const ductMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x3b414d,
        roughness: 0.6,
        metalness: 0.5,
      }),
    );
    [-halfW * 0.7, halfW * 0.7].forEach((dx) => {
      const duct = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.5, dimZ - 2),
        ductMat,
      );
      duct.position.set(dx, ROOM_H - 0.4, cz);
      decor.add(duct);
    });

    // Framed motivational posters on the side walls
    const posterGeo = new THREE.PlaneGeometry(1.15, 1.72);
    const frameGeo = new THREE.BoxGeometry(1.3, 1.88, 0.06);
    const frameMat = track(
      new THREE.MeshStandardMaterial({ color: 0x14161f, roughness: 0.6 }),
    );
    const posterDefs: {
      side: number;
      z: number;
      bg: string;
      accent: string;
      title: string;
      sub: string;
    }[] = [
      {
        side: -1,
        z: gridD * 0.18,
        bg: "#0f2a22",
        accent: "#34d399",
        title: "{ }",
        sub: "SHIP IT",
      },
      {
        side: -1,
        z: gridD * 0.62,
        bg: "#1a1230",
        accent: "#c084fc",
        title: "λ",
        sub: "REFACTOR",
      },
      {
        side: 1,
        z: gridD * 0.18,
        bg: "#0e2436",
        accent: "#22d3ee",
        title: "</>",
        sub: "DEPLOY",
      },
      {
        side: 1,
        z: gridD * 0.62,
        bg: "#2e1b10",
        accent: "#fbbf24",
        title: "0",
        sub: "BUGS",
      },
    ];
    posterDefs.forEach((d) => {
      const tex = track(posterTexture(d.bg, d.accent, d.title, d.sub));
      const pMat = track(
        new THREE.MeshStandardMaterial({
          map: tex,
          emissiveMap: tex,
          emissive: 0xffffff,
          emissiveIntensity: 0.35,
          roughness: 0.6,
        }),
      );
      const x = d.side * (halfW - 0.08);
      const rotY = d.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      const frame = new THREE.Mesh(frameGeo, frameMat);
      frame.position.set(d.side * (halfW - 0.03), 2.25, d.z);
      frame.rotation.y = rotY;
      decor.add(frame);
      const poster = new THREE.Mesh(posterGeo, pMat);
      poster.position.set(x, 2.25, d.z);
      poster.rotation.y = rotY;
      decor.add(poster);
    });

    scene.add(decor);

    // ── Shared geometries for rigs ───────────────────────────────────────────
    const deskTopGeo = new THREE.BoxGeometry(2.6, 0.1, 1.3);
    const deskLegGeo = new THREE.BoxGeometry(0.1, 0.78, 0.1);
    const monitorGeo = new THREE.BoxGeometry(1.0, 0.6, 0.05);
    const monitorStandGeo = new THREE.BoxGeometry(0.1, 0.3, 0.1);
    const headGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const torsoGeo = new THREE.CapsuleGeometry(0.26, 0.5, 4, 12);
    const armGeo = new THREE.CapsuleGeometry(0.07, 0.42, 4, 8);
    const bodyHitGeo = new THREE.BoxGeometry(0.6, 0.9, 0.45);
    const headHitGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const mugGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.13, 10);
    const paperGeo = new THREE.BoxGeometry(0.3, 0.01, 0.4);
    const seatGeo = new THREE.BoxGeometry(0.5, 0.08, 0.5);
    const seatBackGeo = new THREE.BoxGeometry(0.5, 0.6, 0.08);
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.45, 8);

    const monMatScreen = track(
      new THREE.MeshStandardMaterial({
        map: codeTex,
        emissiveMap: codeTex,
        emissive: 0xffffff,
        emissiveIntensity: 2.5,
        roughness: 0.4,
        metalness: 0.1,
      }),
    );
    const mugMat = track(
      new THREE.MeshStandardMaterial({ color: 0xcc4444, roughness: 0.5 }),
    );
    const paperMat = track(
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.9 }),
    );
    const hitMat = track(new THREE.MeshBasicMaterial({ visible: false }));

    const buildChair = (): THREE.Group => {
      const g = new THREE.Group();
      const seat = new THREE.Mesh(seatGeo, chairMat);
      seat.position.y = 0.5;
      const back = new THREE.Mesh(seatBackGeo, chairMat);
      back.position.set(0, 0.82, -0.24);
      const pole = new THREE.Mesh(poleGeo, metalMat);
      pole.position.y = 0.27;
      g.add(seat, back, pole);
      return g;
    };

    function buildRig(slot: number, a: Agent): Rig {
      const pos = slotPos(slot);
      const group = new THREE.Group();
      group.position.copy(pos);

      const desk = new THREE.Mesh(deskTopGeo, deskMat);
      desk.position.set(0, 0.82, 0.2);
      desk.castShadow = true;
      desk.receiveShadow = true;
      group.add(desk);
      for (const [lx, lz] of [
        [-1.2, -0.5],
        [1.2, -0.5],
        [-1.2, 0.9],
        [1.2, 0.9],
      ] as const) {
        const leg = new THREE.Mesh(deskLegGeo, metalMat);
        leg.position.set(lx, 0.39, 0.2 + lz);
        group.add(leg);
      }

      const monitorMat = monMatScreen.clone();
      const monitor = new THREE.Mesh(monitorGeo, monitorMat);
      monitor.position.set(0, 1.35, 0.0);
      monitor.rotation.y = Math.PI;
      group.add(monitor);
      const stand = new THREE.Mesh(monitorStandGeo, metalMat);
      stand.position.set(0, 1.0, 0.0);
      group.add(stand);

      const st = STATUS[safeStatus(a.agent_status)];
      const bloom = makeBloom(st.c, 1.6, 0.5);
      bloom.position.set(0, 1.35, 0.1);
      group.add(bloom);

      const light = new THREE.PointLight(st.c, st.i, 4.5, 2);
      light.position.set(0, 1.45, 0.2);
      group.add(light);

      const mug = new THREE.Mesh(mugGeo, mugMat);
      mug.position.set(-0.9, 0.93, 0.3);
      group.add(mug);
      const paper = new THREE.Mesh(paperGeo, paperMat);
      paper.position.set(0.85, 0.88, 0.4);
      paper.rotation.y = 0.3;
      group.add(paper);

      const chair = buildChair();
      chair.position.set(0, 0, 1.0);
      group.add(chair);

      const torso = new THREE.Mesh(torsoGeo, chairMat.clone());
      torso.position.set(0, 1.05, 1.0);
      group.add(torso);
      const head = new THREE.Mesh(headGeo, skinMat);
      head.position.set(0, 1.55, 1.0);
      group.add(head);
      const armL = new THREE.Mesh(armGeo, chairMat.clone());
      armL.position.set(-0.28, 1.1, 0.7);
      armL.rotation.z = 0.5;
      armL.rotation.x = -0.6;
      group.add(armL);
      const armR = new THREE.Mesh(armGeo, chairMat.clone());
      armR.position.set(0.28, 1.1, 0.7);
      armR.rotation.z = -0.5;
      armR.rotation.x = -0.6;
      group.add(armR);

      const body = new THREE.Mesh(bodyHitGeo, hitMat);
      body.position.set(0, 1.1, 1.0);
      body.userData = { paneId: a.pane_id, part: "body" };
      group.add(body);
      const headBox = new THREE.Mesh(headHitGeo, hitMat);
      headBox.position.set(0, 1.55, 1.0);
      headBox.userData = { paneId: a.pane_id, part: "head" };
      group.add(headBox);

      const { texture: signTex, aspect } = makeLabelTexture(repoName(a));
      const signMat = new THREE.SpriteMaterial({
        map: signTex,
        depthWrite: false,
        transparent: true,
      });
      const sign = new THREE.Sprite(signMat);
      sign.scale.set(1.6, 1.6 / aspect, 1);
      sign.position.set(0, 2.4, 0.5);
      group.add(sign);

      scene.add(group);

      return {
        group,
        monitorMat,
        light,
        bloom,
        head: headBox,
        body,
        torso,
        armL,
        armR,
        chair,
        sign,
        signTex,
        status: safeStatus(a.agent_status),
        targetColor: new THREE.Color(st.c),
        targetIntensity: st.i,
        paneId: a.pane_id,
        focused: !!a.focused,
        seed: Math.random() * 100,
        slot,
        dead: false,
        deathT: 0,
        signText: repoName(a),
      };
    }

    // ── Rig registry & slot assignment ───────────────────────────────────────
    const rigs = new Map<string, Rig>();
    const slotByKey = new Map<string, number>();
    const usedSlots = new Set<number>();
    const hitCounts = new Map<string, number>();
    const killing = new Set<string>();
    const bubbleCache = new Map<string, string>();
    let killfeedId = 0;

    const keyOf = (a: Agent) => a.workspace_id || a.pane_id;

    const assignSlot = (key: string): number => {
      const existing = slotByKey.get(key);
      if (existing !== undefined) return existing;
      for (let s = 0; s < MAX_DESKS; s++) {
        if (!usedSlots.has(s)) {
          usedSlots.add(s);
          slotByKey.set(key, s);
          return s;
        }
      }
      // Overflow: all MAX_DESKS slots are taken. Return a sentinel so the
      // caller skips rendering this agent rather than colliding on slot 0.
      return -1;
    };

    // ── VFX pools ────────────────────────────────────────────────────────────
    const scratchV = new THREE.Vector3();
    const scratchV2 = new THREE.Vector3();

    const TRACER_N = 8;
    interface Tracer {
      line: THREE.Line;
      mat: THREE.LineBasicMaterial;
      t: number;
    }
    const tracers: Tracer[] = [];
    for (let i = 0; i < TRACER_N; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(6), 3),
      );
      const mat = new THREE.LineBasicMaterial({
        color: 0xfff4aa,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(g, mat);
      line.frustumCulled = false;
      scene.add(line);
      tracers.push({ line, mat, t: 0 });
    }
    let tracerIdx = 0;
    const fireTracer = (from: THREE.Vector3, to: THREE.Vector3) => {
      const tr = tracers[tracerIdx++ % TRACER_N];
      const pos = tr.line.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      tr.mat.opacity = 0.9;
      tr.t = 1;
    };

    const IMPACT_N = 3;
    interface Impact {
      light: THREE.PointLight;
      t: number;
    }
    const impacts: Impact[] = [];
    for (let i = 0; i < IMPACT_N; i++) {
      const l = new THREE.PointLight(0xff8844, 0, 3, 2);
      scene.add(l);
      impacts.push({ light: l, t: 0 });
    }
    let impactIdx = 0;
    const popImpact = (p: THREE.Vector3, color: number, power: number) => {
      const im = impacts[impactIdx++ % IMPACT_N];
      im.light.position.copy(p);
      im.light.color.setHex(color);
      im.light.intensity = power;
      im.t = 1;
    };

    const SPARK_N = 48;
    interface Particle {
      sprite: THREE.Sprite;
      vel: THREE.Vector3;
      t: number;
      grav: number;
      kind: "spark" | "poof" | "confetti" | "ring";
    }
    const particles: Particle[] = [];
    for (let i = 0; i < SPARK_N; i++) {
      const m = bloomMat.clone();
      m.opacity = 0;
      const s = new THREE.Sprite(m);
      s.scale.setScalar(0.2);
      s.visible = false;
      scene.add(s);
      particles.push({
        sprite: s,
        vel: new THREE.Vector3(),
        t: 0,
        grav: 0,
        kind: "spark",
      });
    }
    let partIdx = 0;
    const spawnParticle = (
      p: THREE.Vector3,
      color: number,
      kind: Particle["kind"],
      speed: number,
      scale: number,
    ) => {
      const pt = particles[partIdx++ % SPARK_N];
      pt.sprite.position.copy(p);
      pt.sprite.visible = true;
      pt.sprite.scale.setScalar(scale);
      const m = pt.sprite.material as THREE.SpriteMaterial;
      m.color.setHex(color);
      m.opacity = 1;
      m.map = kind === "ring" ? ringTex : bloomTex;
      pt.vel.set(
        (Math.random() - 0.5) * speed,
        Math.random() * speed,
        (Math.random() - 0.5) * speed,
      );
      pt.grav = kind === "confetti" ? -4 : kind === "spark" ? -2 : 0;
      pt.t = 1;
      pt.kind = kind;
    };
    const burst = (
      p: THREE.Vector3,
      color: number,
      kind: Particle["kind"],
      n: number,
      speed: number,
      scale: number,
    ) => {
      for (let i = 0; i < n; i++) spawnParticle(p, color, kind, speed, scale);
    };

    const SHELL_N = 10;
    interface Shell {
      mesh: THREE.Mesh;
      vel: THREE.Vector3;
      av: THREE.Vector3;
      t: number;
    }
    const shellGeo2 = new THREE.CylinderGeometry(0.012, 0.012, 0.05, 6);
    const shellMat = track(
      new THREE.MeshStandardMaterial({
        color: 0xd4a017,
        metalness: 0.8,
        roughness: 0.3,
      }),
    );
    const shells: Shell[] = [];
    for (let i = 0; i < SHELL_N; i++) {
      const m = new THREE.Mesh(shellGeo2, shellMat);
      m.visible = false;
      scene.add(m);
      shells.push({
        mesh: m,
        vel: new THREE.Vector3(),
        av: new THREE.Vector3(),
        t: 0,
      });
    }
    let shellIdx = 0;
    const ejectShell = () => {
      const sh = shells[shellIdx++ % SHELL_N];
      camera.getWorldPosition(scratchV);
      camera.getWorldDirection(scratchV2);
      sh.mesh.position.copy(scratchV).addScaledVector(scratchV2, 0.3);
      sh.mesh.position.y -= 0.2;
      sh.mesh.visible = true;
      sh.vel.set(
        (Math.random() - 0.2) * 2 + 1.5,
        2 + Math.random(),
        (Math.random() - 0.5) * 2,
      );
      sh.av.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
      sh.t = 1.2;
    };

    // ── Coffee pickups ───────────────────────────────────────────────────────
    interface Pickup {
      mesh: THREE.Mesh;
      bloom: THREE.Sprite;
      active: boolean;
      respawn: number;
      basePos: THREE.Vector3;
    }
    const pickups: Pickup[] = [];
    const pickupSpots = [
      new THREE.Vector3(-CELL, 0.95, gridD * 0.3),
      new THREE.Vector3(CELL, 0.95, gridD * 0.6),
      new THREE.Vector3(0, 0.95, gridD + 3),
    ];
    const pickupMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x6f4e37,
        emissive: 0x4422aa,
        emissiveIntensity: 0.6,
        roughness: 0.5,
      }),
    );
    pickupSpots.forEach((p) => {
      const m = new THREE.Mesh(mugGeo, pickupMat);
      m.scale.setScalar(1.4);
      m.position.copy(p);
      scene.add(m);
      const b = makeBloom(0x88aaff, 0.8, 0.6);
      b.position.copy(p);
      scene.add(b);
      pickups.push({
        mesh: m,
        bloom: b,
        active: true,
        respawn: 0,
        basePos: p.clone(),
      });
    });

    // ── WebAudio synth ───────────────────────────────────────────────────────
    let audioCtx: AudioContext | null = null;
    let master: GainNode | null = null;
    let ambientOsc: OscillatorNode | null = null;
    let cachedNoise: AudioBuffer | null = null;
    const initAudio = () => {
      if (audioCtx) return;
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtx = new AC();
      master = audioCtx.createGain();
      master.gain.value = 0.6;
      master.connect(audioCtx.destination);
      ambientOsc = audioCtx.createOscillator();
      ambientOsc.type = "sawtooth";
      ambientOsc.frequency.value = 58;
      const hg = audioCtx.createGain();
      hg.gain.value = 0.012;
      const hf = audioCtx.createBiquadFilter();
      hf.type = "lowpass";
      hf.frequency.value = 200;
      ambientOsc.connect(hf);
      hf.connect(hg);
      hg.connect(master);
      ambientOsc.start();
    };
    const sfxGun = () => {
      if (!audioCtx || !master) return;
      const ctx = audioCtx;
      if (!cachedNoise) {
        const b = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        cachedNoise = b;
      }
      const src = ctx.createBufferSource();
      src.buffer = cachedNoise;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(2400, ctx.currentTime);
      f.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.55, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      src.connect(f);
      f.connect(g);
      g.connect(master);
      src.start();
      src.stop(ctx.currentTime + 0.22);
    };
    const beep = (
      freq: number,
      dur: number,
      type: OscillatorType,
      vol: number,
      slide?: number,
    ) => {
      if (!audioCtx || !master) return;
      const ctx = audioCtx;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, ctx.currentTime);
      if (slide)
        o.frequency.exponentialRampToValueAtTime(slide, ctx.currentTime + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(ctx.currentTime + dur + 0.02);
    };
    const sfxHit = () => beep(1400, 0.06, "square", 0.18);
    const sfxHeadshot = () => {
      beep(1800, 0.08, "square", 0.2);
      beep(2400, 0.07, "sine", 0.14, 1200);
    };
    const sfxKill = () => {
      beep(440, 0.09, "triangle", 0.22, 660);
      window.setTimeout(() => beep(660, 0.09, "triangle", 0.22, 880), 80);
      window.setTimeout(() => beep(880, 0.12, "triangle", 0.22, 1100), 160);
    };
    const sfxReload = () => {
      beep(220, 0.04, "square", 0.2);
      window.setTimeout(() => beep(300, 0.05, "square", 0.2), 220);
    };
    const sfxEmpty = () => beep(180, 0.05, "square", 0.15);
    const sfxShield = () => {
      beep(900, 0.12, "sine", 0.2, 1600);
      beep(1300, 0.1, "triangle", 0.12);
    };
    const sfxPickup = () => {
      beep(880, 0.08, "sine", 0.18, 1320);
      window.setTimeout(() => beep(1320, 0.1, "sine", 0.18, 1760), 60);
    };
    const sfxStep = () => beep(90, 0.05, "sine", 0.06);

    // ── Player & combat state ────────────────────────────────────────────────
    const player = {
      pos: new THREE.Vector3(0, EYE, minZ - 3),
      vel: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      onGround: true,
      crouch: false,
      sprint: false,
      stamina: 100,
      health: 100,
      bob: 0,
      bobStep: 0,
    };
    const keys: Record<string, boolean> = {};
    const combat = {
      ammo: MAG_SIZE,
      reserve: RESERVE_MAX,
      reloading: false,
      reloadEnd: 0,
      lastShot: 0,
      ads: false,
      recoil: 0,
      shake: 0,
      kick: 0,
      score: 0,
      combo: 1,
      comboTimer: 0,
      highScore: 0,
    };
    try {
      combat.highScore = Number(localStorage.getItem("herdr-fps-hi") || "0");
    } catch {
      combat.highScore = 0;
    }
    pushHud({ highScore: combat.highScore });
    let lastHeadshot = false;

    // Gun viewmodel.
    const gun = new THREE.Group();
    const gunBodyGeo = new THREE.BoxGeometry(0.12, 0.14, 0.5);
    const gunBarrelGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8);
    const gunBody = new THREE.Mesh(gunBodyGeo, metalMat);
    const gunBarrel = new THREE.Mesh(gunBarrelGeo, metalMat);
    gunBarrel.rotation.x = Math.PI / 2;
    gunBarrel.position.set(0, 0.04, -0.4);
    gun.add(gunBody, gunBarrel);
    gun.position.set(0.22, -0.22, -0.45);
    camera.add(gun);
    scene.add(camera);

    const muzzleLight = new THREE.PointLight(0xffcc66, 0, 4, 2);
    muzzleLight.position.set(0, 0.04, -0.7);
    gun.add(muzzleLight);
    const muzzleBloom = makeBloom(0xffdd88, 0.6, 0);
    muzzleBloom.position.set(0, 0.04, -0.7);
    gun.add(muzzleBloom);

    const exposure = { val: 1.1, target: 1.1 };
    const raycaster = new THREE.Raycaster();

    // ── Speech bubble for done agents ────────────────────────────────────────
    const hideBubble = (rig: Rig) => {
      if (rig.bubble) {
        rig.group.remove(rig.bubble);
        (rig.bubble.material as THREE.SpriteMaterial).dispose();
        rig.bubbleTex?.dispose();
        rig.bubble = undefined;
        rig.bubbleTex = undefined;
      }
    };
    const showBubble = async (rig: Rig) => {
      if (rig.bubble) return;
      let msg = bubbleCache.get(rig.paneId);
      if (msg === undefined) {
        try {
          const r = await herdr.bubble(rig.paneId);
          msg = r.message || "done";
        } catch {
          msg = "done";
        }
        bubbleCache.set(rig.paneId, msg);
      }
      if (rig.dead || rig.bubble) return;
      const text = msg.slice(0, 80) || "done";
      const { texture, aspect } = makeLabelTexture(text, {
        rtl: isHebrew(text),
        bg: "#dcfce7",
        border: "#16a34a",
      });
      const mat = new THREE.SpriteMaterial({
        map: texture,
        depthWrite: false,
        transparent: true,
      });
      const s = new THREE.Sprite(mat);
      s.scale.set(2.2, 2.2 / aspect, 1);
      s.position.set(0, 3.0, 0.5);
      rig.group.add(s);
      rig.bubble = s;
      rig.bubbleTex = texture;
    };

    // ── Kill handling ────────────────────────────────────────────────────────
    const registerKill = (paneId: string, dyingRig: Rig | undefined) => {
      if (killing.has(paneId)) return;
      killing.add(paneId);
      if (dyingRig) {
        dyingRig.dead = true;
        dyingRig.deathT = 1;
        dyingRig.group.getWorldPosition(scratchV);
        scratchV.y += 1.3;
        burst(scratchV, 0xff3322, "poof", 12, 3, 1.4);
        popImpact(scratchV, 0xff2200, 4);
      }
      const headshot = lastHeadshot;
      const base = 100;
      const bonus = headshot ? 50 : 0;
      combat.combo = Math.min(8, combat.combo + 1);
      combat.comboTimer = 3.5;
      combat.score += (base + bonus) * combat.combo;
      if (combat.score > combat.highScore) {
        combat.highScore = combat.score;
        try {
          localStorage.setItem("herdr-fps-hi", String(combat.highScore));
        } catch {
          /* ignore */
        }
      }
      sfxKill();
      exposure.target = 0.7;
      window.setTimeout(
        () => (exposure.target = combat.ads ? 1.25 : 1.1),
        120,
      );
      killfeedId++;
      const kid = killfeedId;
      const repo = dyingRig?.signText || paneId;
      hudData.killfeed = [
        ...hudData.killfeed,
        {
          id: kid,
          text: `${headshot ? "HEADSHOT " : ""}eliminated ${repo} x${combat.combo}`,
          color: "#ff5544",
        },
      ].slice(-5);
      pushHud({
        score: combat.score,
        combo: combat.combo,
        killFlash: performance.now(),
        highScore: combat.highScore,
      });
      window.setTimeout(() => {
        hudData.killfeed = hudData.killfeed.filter((k) => k.id !== kid);
        hudDirty = true;
      }, 4000);
      herdr.kill(paneId).catch(() => {
        /* best effort */
      });
    };

    const reload = () => {
      if (combat.reloading || combat.ammo >= MAG_SIZE || combat.reserve <= 0)
        return;
      combat.reloading = true;
      combat.reloadEnd = performance.now() + 1100;
      sfxReload();
      pushHud({ reloading: true });
    };

    const sfxGlass = () => {
      beep(2600, 0.05, "square", 0.12, 1300);
      beep(3400, 0.04, "triangle", 0.1, 1700);
      window.setTimeout(() => beep(1500, 0.05, "square", 0.08, 700), 40);
    };
    const breakFluoro = (idx: number, point: THREE.Vector3) => {
      const f = fluoros[idx];
      if (!f || !f.alive) return;
      f.alive = false;
      f.light.intensity = 0;
      f.tubeMat.color.setHex(0x191b22);
      (f.bloom.material as THREE.SpriteMaterial).opacity = 0;
      burst(point, 0xcfe6ff, "spark", 16, 5, 0.22);
      burst(point, 0xffffff, "poof", 4, 1.5, 0.55);
      popImpact(point, 0xbcd4ff, 4);
      sfxGlass();
      combat.shake = Math.max(combat.shake, 0.28);
    };

    const shoot = () => {
      const now = performance.now();
      if (combat.reloading) return;
      if (now - combat.lastShot < 110) return;
      if (combat.ammo <= 0) {
        sfxEmpty();
        reload();
        return;
      }
      combat.lastShot = now;
      combat.ammo--;
      pushHud({ ammo: combat.ammo });
      sfxGun();
      ejectShell();
      muzzleLight.intensity = 5;
      (muzzleBloom.material as THREE.SpriteMaterial).opacity = 1;
      combat.recoil = Math.min(1, combat.recoil + 0.18);
      combat.kick = 0.05 + combat.recoil * 0.06;
      combat.shake = 0.35;
      exposure.target = 1.6;
      window.setTimeout(() => (exposure.target = combat.ads ? 1.25 : 1.1), 60);
      player.pitch += combat.kick * 0.6;

      camera.getWorldPosition(scratchV);
      camera.getWorldDirection(scratchV2);
      const moving = player.vel.lengthSq() > 0.2;
      const spread =
        (combat.recoil * 0.04 + (combat.ads ? 0 : 0.012)) * (moving ? 1.6 : 1);
      scratchV2.x += (Math.random() - 0.5) * spread;
      scratchV2.y += (Math.random() - 0.5) * spread;
      scratchV2.z += (Math.random() - 0.5) * spread;
      scratchV2.normalize();
      raycaster.set(scratchV, scratchV2);
      raycaster.far = 120;

      const targets: THREE.Object3D[] = [];
      rigs.forEach((r) => {
        if (!r.dead) {
          targets.push(r.head, r.body);
        }
      });
      fluoros.forEach((f, i) => {
        if (f.alive) targets.push(fluoroTargets[i]);
      });
      const hits = raycaster.intersectObjects(targets, false);
      const muzzleWorld = gun.localToWorld(new THREE.Vector3(0, 0.04, -0.7));
      let endPoint = scratchV
        .clone()
        .add(scratchV2.clone().multiplyScalar(60));
      if (hits.length) {
        const hit = hits[0];
        endPoint = hit.point.clone();
        if (hit.object.userData.fluoro !== undefined) {
          breakFluoro(hit.object.userData.fluoro as number, endPoint);
          fireTracer(muzzleWorld, endPoint);
          return;
        }
        const paneId = hit.object.userData.paneId as string;
        const part = hit.object.userData.part as string;
        let rig: Rig | undefined;
        rigs.forEach((r) => {
          if (r.paneId === paneId) rig = r;
        });
        if (rig && rig.focused) {
          burst(endPoint, 0x33ccff, "ring", 1, 0, 1.2);
          popImpact(endPoint, 0x33aaff, 3);
          sfxShield();
          pushHud({ shieldHint: performance.now() });
        } else if (rig && !rig.dead) {
          const headshot = part === "head";
          lastHeadshot = headshot;
          burst(endPoint, 0xffaa44, "spark", 6, 4, 0.3);
          popImpact(endPoint, 0xff8844, 2);
          const inc = headshot ? HITS_TO_KILL : 1;
          const c = (hitCounts.get(paneId) || 0) + inc;
          hitCounts.set(paneId, c);
          if (headshot) sfxHeadshot();
          else sfxHit();
          pushHud({ hitmarker: performance.now(), headshot });
          if (c >= HITS_TO_KILL) registerKill(paneId, rig);
        }
      }
      fireTracer(muzzleWorld, endPoint);
    };

    const melee = () => {
      camera.getWorldPosition(scratchV);
      combat.shake = 0.2;
      let nearest: Rig | undefined;
      let nd = 2.2;
      rigs.forEach((r) => {
        if (r.dead) return;
        r.group.getWorldPosition(scratchV2);
        scratchV2.y = scratchV.y;
        const d = scratchV.distanceTo(scratchV2);
        if (d < nd) {
          nd = d;
          nearest = r;
        }
      });
      if (nearest) {
        if (nearest.focused) {
          nearest.group.getWorldPosition(scratchV);
          scratchV.y += 1.3;
          burst(scratchV, 0x33ccff, "ring", 1, 0, 1.2);
          sfxShield();
          pushHud({ shieldHint: performance.now() });
        } else {
          const c = (hitCounts.get(nearest.paneId) || 0) + 1;
          hitCounts.set(nearest.paneId, c);
          sfxHit();
          lastHeadshot = false;
          pushHud({ hitmarker: performance.now(), headshot: false });
          if (c >= HITS_TO_KILL) registerKill(nearest.paneId, nearest);
        }
      }
    };

    const interact = () => {
      camera.getWorldPosition(scratchV);
      camera.getWorldDirection(scratchV2);
      raycaster.set(scratchV, scratchV2);
      raycaster.far = 6;
      const targets: THREE.Object3D[] = [];
      rigs.forEach((r) => {
        if (!r.dead) targets.push(r.body);
      });
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length) {
        const paneId = hits[0].object.userData.paneId as string;
        herdr.focus(paneId).catch(() => {});
        let rig: Rig | undefined;
        rigs.forEach((r) => {
          if (r.paneId === paneId) rig = r;
        });
        if (rig) showBubble(rig);
        sfxPickup();
      }
    };

    // ── Pointer lock & input ─────────────────────────────────────────────────
    const canvasEl = renderer.domElement;
    let locked = false;

    const onLockChange = () => {
      locked = document.pointerLockElement === canvasEl;
      pushHud({ locked });
      if (locked) pushHud({ paused: false });
    };
    document.addEventListener("pointerlockchange", onLockChange);

    const onMouseMove = (e: MouseEvent) => {
      if (!locked) return;
      const sens = combat.ads ? 0.0014 : 0.0024;
      player.yaw -= e.movementX * sens;
      player.pitch -= e.movementY * sens;
      const lim = Math.PI / 2 - 0.05;
      player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
    };
    window.addEventListener("mousemove", onMouseMove);

    let lmb = false;
    const onMouseDown = (e: MouseEvent) => {
      if (!locked) return;
      if (e.button === 0) {
        lmb = true;
        shoot();
      }
      if (e.button === 2) combat.ads = true;
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) lmb = false;
      if (e.button === 2) combat.ads = false;
    };
    const onContext = (e: Event) => e.preventDefault();
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    canvasEl.addEventListener("contextmenu", onContext);

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true;
      // Help/pause toggle works regardless of lock state.
      if (e.code === "KeyH" || e.code === "Tab") {
        e.preventDefault();
        hudData.paused = !hudData.paused;
        hudDirty = true;
        if (hudData.paused && locked) document.exitPointerLock();
        return;
      }
      // Combat & traversal only when the game is active (pointer-locked, unpaused).
      if (!locked || hudData.paused) return;
      if (e.code === "KeyR") reload();
      if (e.code === "KeyF" || e.code === "KeyV") melee();
      if (e.code === "KeyE") interact();
      if (e.code === "Space" && player.onGround) {
        player.vel.y = 5.2;
        player.onGround = false;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const enterGame = () => {
      initAudio();
      audioCtx?.resume();
      hudData.paused = false;
      hudDirty = true;
      canvasEl.requestPointerLock();
    };
    const enterHandler = () => enterGame();
    canvasEl.addEventListener("herdr-enter", enterHandler);

    // ── Diff agents → rigs ───────────────────────────────────────────────────
    const disposeRig = (rig: Rig) => {
      rig.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        const mat = (mesh as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      });
      rig.monitorMat.dispose();
      (rig.torso.material as THREE.Material).dispose();
      (rig.armL.material as THREE.Material).dispose();
      (rig.armR.material as THREE.Material).dispose();
      (rig.bloom.material as THREE.Material).dispose();
      if (rig.sign) (rig.sign.material as THREE.Material).dispose();
      rig.signTex?.dispose();
      hideBubble(rig);
    };

    const syncAgents = (list: Agent[]) => {
      const seen = new Set<string>();
      for (const a of list) {
        const key = keyOf(a);
        seen.add(key);
        let rig = rigs.get(key);
        if (!rig) {
          const slot = assignSlot(key);
          if (slot < 0) continue;
          rig = buildRig(slot, a);
          rigs.set(key, rig);
          rig.group.getWorldPosition(scratchV);
          scratchV.y += 1;
          const st = STATUS[safeStatus(a.agent_status)];
          burst(scratchV, st.c, "spark", 8, 3, 0.4);
          popImpact(scratchV, st.c, 2.5);
        }
        rig.head.userData.paneId = a.pane_id;
        rig.body.userData.paneId = a.pane_id;
        rig.paneId = a.pane_id;
        rig.focused = !!a.focused;
        const nextStatus = safeStatus(a.agent_status);
        if (rig.status !== nextStatus) {
          const prev = rig.status;
          rig.status = nextStatus;
          const st = STATUS[nextStatus];
          rig.targetColor.setHex(st.c);
          rig.targetIntensity = st.i;
          if (nextStatus === "done" && prev !== "done") {
            rig.group.getWorldPosition(scratchV);
            scratchV.y += 2;
            burst(scratchV, 0x44ff88, "confetti", 16, 4, 0.35);
            showBubble(rig);
          }
          if (nextStatus !== "done") hideBubble(rig);
        } else if (nextStatus === "done" && !rig.bubble) {
          showBubble(rig);
        }
        const rn = repoName(a);
        if (rn !== rig.signText && rig.sign) {
          rig.signText = rn;
          const { texture, aspect } = makeLabelTexture(rn);
          (rig.sign.material as THREE.SpriteMaterial).map = texture;
          rig.signTex?.dispose();
          rig.signTex = texture;
          rig.sign.scale.set(1.6, 1.6 / aspect, 1);
        }
      }
      for (const [key, rig] of Array.from(rigs.entries())) {
        if (!seen.has(key)) {
          scene.remove(rig.group);
          disposeRig(rig);
          rigs.delete(key);
          usedSlots.delete(rig.slot);
          slotByKey.delete(key);
          hitCounts.delete(rig.paneId);
          killing.delete(rig.paneId);
          bubbleCache.delete(rig.paneId);
        }
      }
    };

    let lastSig = "";
    const maybeSync = () => {
      const list = agentsRef.current;
      const sig = list
        .map((a) => `${keyOf(a)}:${a.pane_id}:${a.agent_status}:${a.focused}`)
        .join("|");
      if (sig !== lastSig) {
        lastSig = sig;
        syncAgents(list);
      }
    };

    // ── Resize ───────────────────────────────────────────────────────────────
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // ── Minimap ──────────────────────────────────────────────────────────────
    const miniCanvas = document.createElement("canvas");
    miniCanvas.width = miniCanvas.height = 160;
    miniCanvas.style.cssText =
      "position:absolute;right:14px;bottom:14px;width:160px;height:160px;border:2px solid rgba(120,160,220,0.4);border-radius:8px;background:rgba(8,10,20,0.7);pointer-events:none;";
    mount.appendChild(miniCanvas);
    const miniCtx = miniCanvas.getContext("2d")!;
    const drawMini = () => {
      miniCtx.clearRect(0, 0, 160, 160);
      const mapX = (x: number) => ((x + halfW) / ROOM_W) * 150 + 5;
      const mapZ = (z: number) => ((z - minZ) / (maxZ - minZ)) * 150 + 5;
      rigs.forEach((r) => {
        r.group.getWorldPosition(scratchV);
        miniCtx.fillStyle = r.dead ? "#444" : STATUS_HEX[r.status];
        const px = mapX(scratchV.x);
        const pz = mapZ(scratchV.z);
        miniCtx.fillRect(px - 3, pz - 3, 6, 6);
        if (r.focused) {
          miniCtx.strokeStyle = "#ffd700";
          miniCtx.lineWidth = 2;
          miniCtx.strokeRect(px - 4, pz - 4, 8, 8);
        }
      });
      const px = mapX(player.pos.x);
      const pz = mapZ(player.pos.z);
      miniCtx.save();
      miniCtx.translate(px, pz);
      miniCtx.rotate(-player.yaw);
      miniCtx.fillStyle = "#ffffff";
      miniCtx.beginPath();
      miniCtx.moveTo(0, -6);
      miniCtx.lineTo(4, 5);
      miniCtx.lineTo(-4, 5);
      miniCtx.closePath();
      miniCtx.fill();
      miniCtx.strokeStyle = "rgba(120,200,255,0.5)";
      miniCtx.beginPath();
      miniCtx.moveTo(0, 0);
      miniCtx.lineTo(0, -22);
      miniCtx.stroke();
      miniCtx.restore();
    };

    // ── Main loop ────────────────────────────────────────────────────────────
    let raf = 0;
    let last = performance.now();
    let fpsFrames = 0;
    let fpsTimer = 0;
    let codeAcc = 0;
    const ledTmpColor = new THREE.Color();
    const baseFOV = 72;
    const camEuler = new THREE.Euler(0, 0, 0, "YXZ");

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.05) dt = 0.05;

      maybeSync();

      const paused = hudData.paused || !locked;

      if (!paused) {
        player.crouch = !!keys["KeyC"];
        const speedBase = player.crouch ? 2.2 : 4.4;
        player.sprint =
          !!keys["ShiftLeft"] && !player.crouch && player.stamina > 1;
        let speed = speedBase;
        if (player.sprint) {
          speed *= 1.6;
          player.stamina = Math.max(0, player.stamina - dt * 28);
        } else {
          player.stamina = Math.min(100, player.stamina + dt * 16);
        }
        const fwd = (keys["KeyW"] ? 1 : 0) - (keys["KeyS"] ? 1 : 0);
        const str = (keys["KeyD"] ? 1 : 0) - (keys["KeyA"] ? 1 : 0);
        const sinY = Math.sin(player.yaw);
        const cosY = Math.cos(player.yaw);
        const moveX = -sinY * fwd + cosY * str;
        const moveZ = -cosY * fwd - sinY * str;
        const mlen = Math.hypot(moveX, moveZ) || 1;
        const horizSpeed = fwd || str ? speed : 0;
        player.vel.x = (moveX / mlen) * horizSpeed;
        player.vel.z = (moveZ / mlen) * horizSpeed;

        player.vel.y -= 14 * dt;
        player.pos.x += player.vel.x * dt;
        player.pos.z += player.vel.z * dt;
        player.pos.y += player.vel.y * dt;

        const eyeH = player.crouch ? CROUCH_EYE : EYE;
        if (player.pos.y <= eyeH) {
          player.pos.y = eyeH;
          player.vel.y = 0;
          player.onGround = true;
        }

        const m = 0.6;
        player.pos.x = Math.max(-halfW + m, Math.min(halfW - m, player.pos.x));
        player.pos.z = Math.max(minZ + m, Math.min(maxZ - m, player.pos.z));

        const moving = horizSpeed > 0 && player.onGround;
        if (moving) {
          player.bob += dt * (player.sprint ? 16 : 11);
          if (Math.sin(player.bob) > 0.96 && now - player.bobStep > 260) {
            player.bobStep = now;
            sfxStep();
          }
        } else {
          player.bob *= 0.9;
        }

        if (lmb) shoot();
      } else {
        player.vel.x = player.vel.z = 0;
      }

      if (combat.reloading && now >= combat.reloadEnd) {
        const need = MAG_SIZE - combat.ammo;
        const take = Math.min(need, combat.reserve);
        combat.ammo += take;
        combat.reserve -= take;
        combat.reloading = false;
        pushHud({
          ammo: combat.ammo,
          reserve: combat.reserve,
          reloading: false,
        });
      }

      combat.recoil *= Math.pow(0.0001, dt);
      combat.kick *= Math.pow(0.0001, dt);
      combat.shake *= Math.pow(0.001, dt);

      if (combat.comboTimer > 0) {
        combat.comboTimer -= dt;
        if (combat.comboTimer <= 0 && combat.combo > 1) {
          combat.combo = 1;
          pushHud({ combo: 1 });
        }
      }

      const bobY = Math.sin(player.bob) * 0.05;
      const bobX = Math.cos(player.bob * 0.5) * 0.03;
      camera.position.set(
        player.pos.x + bobX + (Math.random() - 0.5) * combat.shake * 0.1,
        player.pos.y + bobY + (Math.random() - 0.5) * combat.shake * 0.1,
        player.pos.z,
      );
      camEuler.set(player.pitch, player.yaw, 0, "YXZ");
      camera.quaternion.setFromEuler(camEuler);

      const targetFOV = combat.ads ? baseFOV * 0.72 : baseFOV;
      camera.fov += (targetFOV - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
      if (combat.ads) exposure.target = 1.25;

      exposure.val += (exposure.target - exposure.val) * Math.min(1, dt * 12);
      renderer.toneMappingExposure = exposure.val;

      muzzleLight.intensity *= 0.82;
      (muzzleBloom.material as THREE.SpriteMaterial).opacity *= 0.8;

      codeAcc += dt;
      if (codeAcc > 0.055) {
        codeAcc = 0;
        codeScroll += 3;
        drawCode();
      }

      for (let k = 0; k < ledCount; k++) {
        if (Math.random() < 0.04) {
          ledTmpColor.setHSL(Math.random(), 0.9, 0.5);
          ledTmpColor.toArray(ledColors, k * 3);
        }
      }
      (ledInst.instanceColor as THREE.InstancedBufferAttribute).needsUpdate =
        true;

      const t = now / 1000;

      for (const f of fluoros) {
        if (!f.alive) continue;
        const bm = f.bloom.material as THREE.SpriteMaterial;
        if (f.broken) {
          const wave =
            Math.sin(t * 31 + f.seed) * Math.sin(t * 12.7 + f.seed * 2.3);
          let on = wave > -0.35 ? 1 : 0;
          if (Math.random() < 0.07) on = Math.random() < 0.5 ? 0 : 1;
          const lvl = on ? 0.65 + Math.random() * 0.55 : 0.03;
          f.light.intensity = f.baseI * lvl;
          f.tubeMat.color.setRGB(
            0.72 * lvl + 0.08,
            0.79 * lvl + 0.08,
            0.92 * lvl + 0.1,
          );
          bm.opacity = 0.5 * lvl;
        } else {
          const hum = 0.96 + 0.04 * Math.sin(t * 58 + f.seed);
          f.light.intensity = f.baseI * hum;
          bm.opacity = 0.5 * hum;
        }
      }

      rigs.forEach((r) => {
        r.light.color.lerp(r.targetColor, 0.1);
        r.light.intensity += (r.targetIntensity - r.light.intensity) * 0.1;
        r.monitorMat.emissive.lerp(r.targetColor, 0.1);
        (r.bloom.material as THREE.SpriteMaterial).color.lerp(
          r.targetColor,
          0.1,
        );

        if (r.dead) {
          r.deathT = Math.max(0, r.deathT - 0.02);
          r.group.rotation.z = Math.min(Math.PI / 2, r.group.rotation.z + 0.05);
          r.light.intensity *= 0.9;
          (r.bloom.material as THREE.SpriteMaterial).opacity *= 0.9;
          if (r.sign) (r.sign.material as THREE.SpriteMaterial).opacity *= 0.95;
          return;
        }

        const flick = 0.8 + 0.4 * Math.sin(t * 22 + r.seed);
        const bm = r.bloom.material as THREE.SpriteMaterial;
        switch (r.status) {
          case "working":
            r.light.intensity = r.targetIntensity * flick;
            r.armR.rotation.x = -0.6 + Math.sin(t * 14 + r.seed) * 0.25;
            r.armL.rotation.x = -0.6 + Math.cos(t * 14 + r.seed) * 0.25;
            r.torso.rotation.x = 0.05;
            bm.opacity = 0.5 + 0.2 * Math.sin(t * 22 + r.seed);
            break;
          case "idle":
            r.torso.rotation.x = 0.35;
            r.armR.rotation.x = -0.2;
            r.armL.rotation.x = -0.2;
            bm.opacity = 0.3;
            break;
          case "blocked":
            r.torso.rotation.x = 0.1;
            r.light.intensity =
              r.targetIntensity * (0.5 + 0.5 * Math.abs(Math.sin(t * 3)));
            bm.opacity = 0.4 + 0.4 * Math.abs(Math.sin(t * 3));
            break;
          case "done":
            r.torso.rotation.x = -0.25;
            r.armR.rotation.x = 0.3;
            r.armL.rotation.x = 0.3;
            r.light.intensity =
              r.targetIntensity * (0.7 + 0.3 * Math.sin(t * 2 + r.seed));
            bm.opacity = 0.4 + 0.2 * Math.sin(t * 2);
            if (r.bubble) r.bubble.position.y = 3.0 + Math.sin(t * 2) * 0.05;
            break;
          default:
            bm.opacity = 0.3;
        }
      });

      for (const tr of tracers) {
        if (tr.t > 0) {
          tr.t -= dt * 8;
          tr.mat.opacity = Math.max(0, tr.t);
        }
      }
      for (const im of impacts) {
        if (im.t > 0) {
          im.t -= dt * 6;
          im.light.intensity = Math.max(0, im.t * 3);
        }
      }
      for (const pt of particles) {
        if (pt.t > 0) {
          pt.t -= dt * (pt.kind === "confetti" ? 1.2 : 2.4);
          pt.vel.y += pt.grav * dt;
          pt.sprite.position.addScaledVector(pt.vel, dt);
          const mat = pt.sprite.material as THREE.SpriteMaterial;
          if (pt.kind === "ring") {
            pt.sprite.scale.setScalar(1.2 + (1 - pt.t) * 2);
          }
          mat.opacity = Math.max(0, pt.t);
          if (pt.t <= 0) pt.sprite.visible = false;
        }
      }
      for (const sh of shells) {
        if (sh.t > 0) {
          sh.t -= dt;
          sh.vel.y -= 18 * dt;
          sh.mesh.position.addScaledVector(sh.vel, dt);
          sh.mesh.rotation.x += sh.av.x * dt;
          sh.mesh.rotation.y += sh.av.y * dt;
          if (sh.mesh.position.y < 0.03) {
            sh.mesh.position.y = 0.03;
            sh.vel.set(0, 0, 0);
          }
          if (sh.t <= 0) sh.mesh.visible = false;
        }
      }

      for (const pk of pickups) {
        if (pk.active) {
          pk.mesh.rotation.y += dt * 2;
          pk.mesh.position.y = pk.basePos.y + Math.sin(t * 3) * 0.08;
          const d = Math.hypot(
            player.pos.x - pk.basePos.x,
            player.pos.z - pk.basePos.z,
          );
          if (d < 1.2) {
            pk.active = false;
            pk.mesh.visible = false;
            pk.bloom.visible = false;
            pk.respawn = now + 12000;
            combat.reserve = Math.min(RESERVE_MAX, combat.reserve + 24);
            player.health = Math.min(100, player.health + 20);
            sfxPickup();
            burst(pk.basePos, 0x88ccff, "spark", 8, 3, 0.3);
            pushHud({ reserve: combat.reserve, health: player.health });
          }
        } else if (now >= pk.respawn) {
          pk.active = true;
          pk.mesh.visible = true;
          pk.bloom.visible = true;
        }
      }

      for (const b of panelBlooms) {
        (b.material as THREE.SpriteMaterial).opacity =
          0.28 + 0.04 * Math.sin(t * 5);
      }
      (neonBloom.material as THREE.SpriteMaterial).opacity =
        0.45 + 0.1 * Math.sin(t * 3);

      const liveSpread =
        6 +
        combat.recoil * 30 +
        (player.vel.lengthSq() > 0.2 ? 8 : 0) +
        (combat.ads ? -4 : 0);

      fpsFrames++;
      fpsTimer += dt;
      if (fpsTimer >= 0.5) {
        pushHud({ fps: Math.round(fpsFrames / fpsTimer) });
        fpsFrames = 0;
        fpsTimer = 0;
      }

      pushHud({
        stamina: Math.round(player.stamina),
        health: Math.round(player.health),
        spread: Math.max(2, liveSpread),
      });

      drawMini();
      renderer.render(scene, camera);

      if (hudDirty) {
        hudDirty = false;
        const snapshot: HudState = {
          health: hudData.health,
          stamina: hudData.stamina,
          ammo: hudData.ammo,
          reserve: hudData.reserve,
          reloading: hudData.reloading,
          score: hudData.score,
          combo: hudData.combo,
          killfeed: hudData.killfeed,
          objective: hudData.objective,
          fps: hudData.fps,
          hitmarker: hudData.hitmarker,
          headshot: hudData.headshot,
          damageFlash: hudData.damageFlash,
          killFlash: hudData.killFlash,
          shieldHint: hudData.shieldHint,
          paused: hudData.paused,
          locked: hudData.locked,
          connected: hudData.connected,
          error: hudData.error,
          highScore: hudData.highScore,
          spread: hudData.spread,
        };
        setHud((prev) => ({
          ...snapshot,
          connected: prev.connected,
          error: prev.error,
        }));
      }
    };
    raf = requestAnimationFrame(tick);

    // ── Teardown ─────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvasEl.removeEventListener("contextmenu", onContext);
      canvasEl.removeEventListener("herdr-enter", enterHandler);
      if (document.pointerLockElement === canvasEl) document.exitPointerLock();

      rigs.forEach((r) => disposeRig(r));
      rigs.clear();

      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      [
        deskTopGeo,
        deskLegGeo,
        monitorGeo,
        monitorStandGeo,
        headGeo,
        torsoGeo,
        armGeo,
        bodyHitGeo,
        headHitGeo,
        mugGeo,
        paperGeo,
        seatGeo,
        seatBackGeo,
        poleGeo,
        shellGeo2,
        potGeo,
        leafGeo,
        rackGeo,
        ledGeo,
        partGeo,
        panelGeo,
        wbGeo,
        shellGeo,
        ceilGeo,
        backWallGeo,
        neonGeo,
        gunBodyGeo,
        gunBarrelGeo,
        floor.geometry,
      ].forEach((g) => g.dispose());
      tracers.forEach((tr) => {
        tr.line.geometry.dispose();
        tr.mat.dispose();
      });
      particles.forEach((p) =>
        (p.sprite.material as THREE.Material).dispose(),
      );
      disposables.forEach((d) => d.dispose());
      bloomMat.dispose();

      renderer.dispose();
      if (miniCanvas.parentElement) miniCanvas.remove();
      if (renderer.domElement.parentElement) renderer.domElement.remove();

      try {
        ambientOsc?.stop();
      } catch {
        /* ignore */
      }
      audioCtx?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lowAmmo = hud.ammo <= 3;
  const enterCanvas = () => {
    const c = mountRef.current?.querySelector("canvas");
    c?.dispatchEvent(new Event("herdr-enter"));
  };
  const recent = (ts: number, ms: number) => Date.now() - ts < ms;

  return (
    <div
      ref={mountRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#05060d",
        cursor: hud.locked ? "none" : "default",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          boxShadow: "inset 0 0 220px 60px rgba(0,0,0,0.75)",
          transition: "background 0.1s",
          background: recent(hud.killFlash, 140)
            ? "rgba(255,255,255,0.18)"
            : recent(hud.damageFlash, 200)
              ? "rgba(255,0,0,0.22)"
              : "transparent",
        }}
      />

      {hud.locked && !hud.paused && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%,-50%)",
            pointerEvents: "none",
          }}
        >
          {[
            { w: 2, h: 8, x: 0, y: -(hud.spread + 8) },
            { w: 2, h: 8, x: 0, y: hud.spread },
            { w: 8, h: 2, x: -(hud.spread + 8), y: 0 },
            { w: 8, h: 2, x: hud.spread, y: 0 },
          ].map((c, i) => (
            <span
              key={i}
              style={{
                position: "absolute",
                width: c.w,
                height: c.h,
                left: c.x,
                top: c.y,
                background: "rgba(180,255,210,0.9)",
                boxShadow: "0 0 4px rgba(120,255,180,0.8)",
              }}
            />
          ))}
          {recent(hud.hitmarker, 140) && (
            <span
              style={{
                position: "absolute",
                left: -10,
                top: -10,
                width: 20,
                height: 20,
                color: hud.headshot ? "#ff4444" : "#fff",
                fontWeight: 900,
                fontSize: 18,
                lineHeight: "20px",
                textAlign: "center",
              }}
            >
              x
            </span>
          )}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          left: 16,
          top: 14,
          color: "#dbeafe",
          textShadow: "0 1px 4px #000",
          pointerEvents: "none",
        }}
      >
        <div style={{ fontSize: 26, fontWeight: 800 }}>
          {hud.score.toLocaleString()}
          {hud.combo > 1 && (
            <span style={{ color: "#ffd700", marginLeft: 10, fontSize: 18 }}>
              x{hud.combo}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          high {hud.highScore.toLocaleString()}
        </div>
        <div style={{ fontSize: 13, marginTop: 6, opacity: 0.85, maxWidth: 320 }}>
          {hud.objective}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 16,
          top: 14,
          color: "#cbd5e1",
          textAlign: "right",
          fontSize: 12,
          textShadow: "0 1px 3px #000",
          pointerEvents: "none",
        }}
      >
        <div style={{ fontWeight: 700 }}>{hud.fps} FPS</div>
        <div
          style={{ color: hud.connected ? "#4ade80" : "#fbbf24", marginTop: 2 }}
        >
          {hud.connected ? "live" : "polling"}
        </div>
        {hud.error && (
          <div style={{ color: "#f87171", maxWidth: 220 }}>{hud.error}</div>
        )}
        <div style={{ marginTop: 8, display: "grid", gap: 3 }}>
          {(["working", "idle", "blocked", "done"] as AgentStatus[]).map((s) => (
            <div
              key={s}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              <span style={{ opacity: 0.8 }}>{s}</span>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: STATUS_HEX[s],
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 16,
          top: 150,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          alignItems: "flex-end",
          pointerEvents: "none",
        }}
      >
        {hud.killfeed.map((k) => (
          <div
            key={k.id}
            style={{
              color: k.color,
              fontSize: 13,
              fontWeight: 700,
              textShadow: "0 1px 3px #000",
              background: "rgba(0,0,0,0.35)",
              padding: "2px 8px",
              borderRadius: 4,
            }}
          >
            {k.text}
          </div>
        ))}
      </div>

      <div
        style={{
          position: "absolute",
          left: 16,
          bottom: 16,
          color: "#e2e8f0",
          pointerEvents: "none",
          width: 220,
        }}
      >
        <Bar label="HP" value={hud.health} color="#ef4444" />
        <Bar label="STA" value={hud.stamina} color="#22d3ee" />
        <div
          style={{
            marginTop: 8,
            fontSize: 30,
            fontWeight: 900,
            color: lowAmmo ? "#ff4444" : "#fff",
            textShadow: "0 1px 4px #000",
            animation: lowAmmo ? "herdrpulse 0.6s infinite" : undefined,
          }}
        >
          {hud.reloading ? "RELOADING" : `${hud.ammo}`}
          <span style={{ fontSize: 16, opacity: 0.6 }}> / {hud.reserve}</span>
        </div>
      </div>

      {recent(hud.shieldHint, 900) && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "58%",
            transform: "translateX(-50%)",
            color: "#7dd3fc",
            fontWeight: 800,
            fontSize: 18,
            textShadow: "0 0 8px #0891b2",
            pointerEvents: "none",
          }}
        >
          shielded — controller agent protected
        </div>
      )}

      {!hud.locked && !hud.paused && (
        <div
          onClick={enterCanvas}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(5,7,16,0.78)",
            color: "#e2e8f0",
            cursor: "pointer",
            textAlign: "center",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 900, color: "#7dd3fc" }}>
            herdr · night office
          </div>
          <div style={{ fontSize: 18, opacity: 0.9 }}>click to enter</div>
          <div style={{ fontSize: 13, opacity: 0.6, maxWidth: 480 }}>
            WASD move · Mouse look · LMB shoot · RMB aim · R reload · Space jump ·
            Shift sprint · C crouch · F/V melee · E focus/interact · H help
          </div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>
            3 hits eliminate an agent (real kill). The focused controller agent is
            shield-protected.
          </div>
        </div>
      )}

      {hud.paused && (
        <div
          onClick={enterCanvas}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(5,7,16,0.85)",
            color: "#e2e8f0",
            cursor: "pointer",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 30, fontWeight: 800, color: "#7dd3fc" }}>
            paused
          </div>
          <div style={{ display: "grid", gap: 4, fontSize: 14, opacity: 0.9 }}>
            <span>Move — WASD</span>
            <span>Look — Mouse</span>
            <span>Shoot — LMB · Aim — RMB</span>
            <span>Reload — R</span>
            <span>Jump — Space · Sprint — Shift · Crouch — C</span>
            <span>Melee — F / V</span>
            <span>Interact / Focus — E</span>
            <span>Help / Pause — H or Tab</span>
          </div>
          <div style={{ fontSize: 13, opacity: 0.6, marginTop: 8 }}>
            {hud.connected ? "live feed" : "polling feed"}
            {hud.error ? ` · ${hud.error}` : ""}
          </div>
          <div
            style={{
              fontSize: 12,
              opacity: 0.55,
              maxWidth: 420,
              textAlign: "center",
            }}
          >
            The shield protects the focused controller agent — it can never be
            killed.
          </div>
          <div style={{ fontSize: 14, marginTop: 10, color: "#7dd3fc" }}>
            click to resume
          </div>
        </div>
      )}

      <style>{`@keyframes herdrpulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>
    </div>
  );
}

function Bar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
      <span
        style={{
          fontSize: 11,
          width: 28,
          color: "#94a3b8",
          textShadow: "0 1px 2px #000",
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 8,
          background: "rgba(255,255,255,0.12)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            height: "100%",
            background: color,
            transition: "width 0.15s",
          }}
        />
      </div>
    </div>
  );
}