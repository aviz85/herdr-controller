"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { type Agent, type AgentStatus, herdr, repoName } from "@/lib/herdr";
import { useAgents } from "@/components/use-agents";
import { makeLabelTexture, isHebrew } from "@/components/office/text-texture";

const STATUS_COLOR: Record<AgentStatus, number> = {
  working: 0x3b82f6,
  idle: 0x71717a,
  blocked: 0xf59e0b,
  done: 0x10b981,
  unknown: 0x3f3f46,
};
const STATUS_ICON: Record<AgentStatus, string> = {
  working: "⌨️",
  idle: "💤",
  blocked: "⚠️",
  done: "✅",
  unknown: "·",
};

const COLS = 4;
const CELL = 7.5;

// One desk + character + signage. Built once, animated/toggled per frame.
interface Office {
  group: THREE.Group;
  character: THREE.Group;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  head: THREE.Object3D;
  body: THREE.Object3D;
  screen: THREE.Mesh;
  screenMat: THREE.MeshStandardMaterial;
  bodyMat: THREE.MeshStandardMaterial;
  chair: THREE.Object3D;
  signSprite: THREE.Sprite | null;
  iconSprite: THREE.Sprite;
  bubbleSprite: THREE.Sprite | null;
  baseX: number;
  baseZ: number;
  status: AgentStatus;
  present: boolean;
  label: string;
  bubbleText: string | null;
  bubbleFetchedFor: string | null;
  phase: number;
}

function makeSprite(tex: THREE.CanvasTexture): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  return new THREE.Sprite(mat);
}

function emojiSprite(emoji: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.font = "96px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, 64, 72);
  const tex = new THREE.CanvasTexture(c);
  return makeSprite(tex);
}

export function OfficeScene() {
  const mountRef = useRef<HTMLDivElement>(null);
  const { agents, connected } = useAgents();
  const agentsRef = useRef<Agent[]>([]);
  const officesRef = useRef<Map<string, Office>>(new Map());
  const slotRef = useRef<Map<string, number>>(new Map());
  const sceneRef = useRef<THREE.Scene | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // ---- one-time three.js setup ----
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b12);
    scene.fog = new THREE.Fog(0x0b0b12, 28, 70);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50,
      mount.clientWidth / mount.clientHeight,
      0.1,
      200,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // lights
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202028, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(12, 22, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -40;
    key.shadow.camera.right = 40;
    key.shadow.camera.top = 40;
    key.shadow.camera.bottom = -40;
    scene.add(key);

    // floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x16161f, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    scene.add(floor);

    // subtle grid
    const grid = new THREE.GridHelper(200, 80, 0x2a2a3a, 0x1d1d28);
    (grid.material as THREE.Material).opacity = 0.4;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // ---- minimal orbit controls ----
    const target = new THREE.Vector3(CELL * (COLS - 1) * 0.5, 1, 4);
    let yaw = -0.5, pitch = 0.85, dist = 26;
    const applyCam = () => {
      camera.position.set(
        target.x + dist * Math.sin(yaw) * Math.cos(pitch),
        target.y + dist * Math.cos(pitch),
        target.z + dist * Math.cos(yaw) * Math.cos(pitch),
      );
      camera.lookAt(target);
    };
    applyCam();
    let dragging = false, px = 0, py = 0;
    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => { dragging = true; px = e.clientX; py = e.clientY; };
    const onUp = () => (dragging = false);
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - px) * 0.005;
      pitch = Math.min(1.45, Math.max(0.15, pitch - (e.clientY - py) * 0.005));
      px = e.clientX; py = e.clientY;
      applyCam();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dist = Math.min(60, Math.max(8, dist + e.deltaY * 0.02));
      applyCam();
    };
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);
    dom.addEventListener("wheel", onWheel, { passive: false });

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    setReady(true);

    // ---- render loop ----
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      syncOffices(scene);
      for (const o of officesRef.current.values()) animateOffice(o, t);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onMove);
      dom.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- build an office (desk + character + cubicle) ----
  function buildOffice(slot: number): Office {
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const baseX = col * CELL;
    const baseZ = row * CELL;

    const group = new THREE.Group();
    group.position.set(baseX, 0, baseZ);

    // cubicle floor tile
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(CELL - 0.6, 0.1, CELL - 0.6),
      new THREE.MeshStandardMaterial({ color: 0x1e1e2a, roughness: 0.9 }),
    );
    tile.position.y = 0.05;
    tile.receiveShadow = true;
    group.add(tile);

    // back + side cubicle walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b2b3a, roughness: 0.8 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(CELL - 0.6, 2.4, 0.18), wallMat);
    back.position.set(0, 1.2, -(CELL - 0.6) / 2);
    back.castShadow = back.receiveShadow = true;
    group.add(back);
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.4, CELL - 0.6), wallMat);
    side.position.set(-(CELL - 0.6) / 2, 1.2, 0);
    side.castShadow = true;
    group.add(side);

    // desk
    const deskMat = new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 0.6 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.18, 1.6), deskMat);
    desk.position.set(0, 1.1, -1.4);
    desk.castShadow = desk.receiveShadow = true;
    group.add(desk);
    for (const sx of [-1.5, 1.5]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16), deskMat);
      leg.position.set(sx, 0.55, -1.4);
      group.add(leg);
    }

    // monitor
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      emissive: 0x2266ff,
      emissiveIntensity: 0.4,
    });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 0.08), screenMat);
    screen.position.set(0, 1.95, -1.85);
    screen.castShadow = true;
    group.add(screen);
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.5, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x111118 }),
    );
    stand.position.set(0, 1.45, -1.85);
    group.add(stand);

    // chair
    const chair = new THREE.Group();
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x18181f, roughness: 0.7 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 1.1), chairMat);
    seat.position.y = 0.95;
    const cback = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 0.16), chairMat);
    cback.position.set(0, 1.5, 0.5);
    chair.add(seat, cback);
    chair.position.set(0, 0, 0.2);
    chair.castShadow = true;
    group.add(chair);

    // ---- character ----
    const character = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.5 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xf2c79b, roughness: 0.6 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 6, 12), bodyMat);
    body.position.y = 1.55;
    body.castShadow = true;
    character.add(body);

    const head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 20), skinMat);
    skull.castShadow = true;
    head.add(skull);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    for (const ex of [-0.12, 0.12]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), eyeMat);
      eye.position.set(ex, 0.04, 0.3);
      head.add(eye);
    }
    head.position.y = 2.25;
    character.add(head);

    const armGeo = new THREE.CapsuleGeometry(0.11, 0.5, 4, 8);
    const mkArm = (sx: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(sx, 1.85, 0);
      const arm = new THREE.Mesh(armGeo, bodyMat);
      arm.position.set(0, -0.3, 0.05);
      arm.castShadow = true;
      pivot.add(arm);
      character.add(pivot);
      return pivot;
    };
    const leftArm = mkArm(-0.46);
    const rightArm = mkArm(0.46);

    // seated at the desk, facing the monitor (-Z)
    character.position.set(0, 0, 0.1);
    group.add(character);

    // floating status icon
    const iconSprite = emojiSprite("·");
    iconSprite.scale.set(0.9, 0.9, 0.9);
    iconSprite.position.set(0, 3.1, 0);
    group.add(iconSprite);

    sceneRef.current!.add(group);

    return {
      group, character, leftArm, rightArm, head, body, screen, screenMat, bodyMat,
      chair, signSprite: null, iconSprite, bubbleSprite: null,
      baseX, baseZ, status: "unknown", present: false, label: "",
      bubbleText: null, bubbleFetchedFor: null, phase: Math.random() * Math.PI * 2,
    };
  }

  // ---- diff agent data -> offices ----
  function syncOffices(scene: THREE.Scene) {
    const list = agentsRef.current;
    const byOffice = new Map<string, Agent>();
    for (const a of list) {
      const id = a.workspace_id || a.pane_id;
      byOffice.set(id, a);
    }

    // ensure an office exists for every workspace we've ever seen
    for (const id of byOffice.keys()) {
      if (!slotRef.current.has(id)) slotRef.current.set(id, slotRef.current.size);
      if (!officesRef.current.has(id)) {
        officesRef.current.set(id, buildOffice(slotRef.current.get(id)!));
      }
    }

    for (const [id, office] of officesRef.current) {
      const a = byOffice.get(id);
      const present = !!a && a.agent_status !== "unknown";
      office.present = present;
      office.status = a?.agent_status ?? "unknown";
      const label = a ? repoName(a) : office.label;
      if (a) office.label = label;

      // project sign (only when occupied)
      if (present && !office.signSprite) {
        const { texture, aspect } = makeLabelTexture(office.label, {
          bg: "#1e293b", border: "#475569", color: "#e2e8f0", size: 52,
        });
        const s = makeSprite(texture);
        s.scale.set(3.2, 3.2 / aspect, 1);
        s.position.set(0, 3.9, -(CELL - 0.6) / 2 + 0.2);
        office.signSprite = s;
        office.group.add(s);
      }
      if (office.signSprite) office.signSprite.visible = present;

      // character visibility + color
      office.character.visible = present;
      office.iconSprite.visible = present;
      if (present) {
        const col = STATUS_COLOR[office.status];
        office.bodyMat.color.setHex(col);
        // update floating icon emoji if changed
        const want = STATUS_ICON[office.status];
        if (office.iconSprite.userData.emoji !== want) {
          office.iconSprite.userData.emoji = want;
          const ns = emojiSprite(want);
          office.iconSprite.material.map = ns.material.map;
          office.iconSprite.material.needsUpdate = true;
        }
      }

      // chair pushed in when empty
      office.chair.position.z = present ? 0.2 : -0.6;

      // ---- done -> speech bubble with last message ----
      if (present && office.status === "done" && a) {
        if (office.bubbleFetchedFor !== a.pane_id) {
          office.bubbleFetchedFor = a.pane_id;
          herdr
            .bubble(a.pane_id)
            .then((r) => {
              office.bubbleText = r.message || "done ✓";
              if (office.bubbleSprite) {
                office.group.remove(office.bubbleSprite);
                office.bubbleSprite = null;
              }
            })
            .catch(() => {
              office.bubbleText = "done ✓";
            });
        }
        if (office.bubbleText && !office.bubbleSprite) {
          const rtl = isHebrew(office.bubbleText);
          const { texture, aspect } = makeLabelTexture(office.bubbleText, {
            bg: "#fffbea", border: "#10b981", color: "#0a0a0a", size: 38, width: 560, rtl,
          });
          const s = makeSprite(texture);
          const h = 4.2 / aspect;
          s.scale.set(4.2, h, 1);
          s.position.set(1.7, 3.4 + h / 2, 0.4);
          s.center.set(0.1, 0);
          office.bubbleSprite = s;
          office.group.add(s);
        }
      } else if (office.bubbleSprite) {
        office.group.remove(office.bubbleSprite);
        office.bubbleSprite.material.map?.dispose();
        office.bubbleSprite = null;
        office.bubbleText = null;
        office.bubbleFetchedFor = null;
      }
    }
  }

  function animateOffice(o: Office, t: number) {
    if (!o.present) {
      o.screenMat.emissiveIntensity = 0.04;
      return;
    }
    const p = o.phase;
    // reset base
    o.group.position.x = o.baseX;
    o.character.rotation.z = 0;
    o.head.rotation.x = 0;
    o.body.rotation.x = 0;

    switch (o.status) {
      case "working": {
        o.leftArm.rotation.x = -1.15 + Math.sin(t * 12 + p) * 0.4;
        o.rightArm.rotation.x = -1.15 + Math.sin(t * 12 + p + Math.PI) * 0.4;
        o.head.position.y = 2.25 + Math.sin(t * 6 + p) * 0.03;
        o.body.rotation.x = 0.16;
        o.screenMat.emissive.setHex(0x2266ff);
        o.screenMat.emissiveIntensity = 0.7 + Math.sin(t * 9 + p) * 0.25;
        break;
      }
      case "idle": {
        o.leftArm.rotation.x = -0.1;
        o.rightArm.rotation.x = -0.1;
        o.character.rotation.z = Math.sin(t * 1.1 + p) * 0.06;
        o.head.rotation.x = 0.35 + Math.sin(t * 0.8 + p) * 0.05; // bored, looking down
        o.screenMat.emissive.setHex(0x223344);
        o.screenMat.emissiveIntensity = 0.15;
        break;
      }
      case "blocked": {
        o.leftArm.rotation.x = -1.6;
        o.rightArm.rotation.x = -1.6; // hands on head
        o.group.position.x = o.baseX + Math.sin(t * 26 + p) * 0.025;
        o.head.rotation.x = -0.1;
        o.screenMat.emissive.setHex(0xff5533);
        o.screenMat.emissiveIntensity = 0.5 + Math.sin(t * 14) * 0.3;
        break;
      }
      case "done": {
        o.leftArm.rotation.x = -0.2;
        o.rightArm.rotation.x = -0.2;
        o.body.rotation.x = -0.12; // leaning back, relaxed
        o.head.position.y = 2.25 + Math.sin(t * 2 + p) * 0.02;
        o.screenMat.emissive.setHex(0x10b981);
        o.screenMat.emissiveIntensity = 0.4;
        break;
      }
      default:
        break;
    }
    // floating icon bob
    o.iconSprite.position.y = 3.1 + Math.sin(t * 2 + p) * 0.12;
  }

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 backdrop-blur">
        <div className="font-semibold text-zinc-100">🏢 herdr office</div>
        <div className="mt-1 text-zinc-400">
          {agents.length} desks ·{" "}
          <span className={connected ? "text-emerald-400" : "text-amber-400"}>
            {connected ? "live" : "polling"}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-zinc-500">
          drag to orbit · scroll to zoom
        </div>
      </div>
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-sm text-zinc-500">
          loading office…
        </div>
      )}
    </div>
  );
}
