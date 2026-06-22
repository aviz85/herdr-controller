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
const MAX_HP = 3;

interface Office {
  group: THREE.Group;
  character: THREE.Group;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  head: THREE.Object3D;
  body: THREE.Object3D;
  screenMat: THREE.MeshStandardMaterial;
  bodyMat: THREE.MeshStandardMaterial;
  chair: THREE.Object3D;
  hitbox: THREE.Mesh;
  healthBar: THREE.Sprite;
  signSprite: THREE.Sprite | null;
  iconSprite: THREE.Sprite;
  bubbleSprite: THREE.Sprite | null;
  baseX: number;
  baseZ: number;
  status: AgentStatus;
  present: boolean;
  focused: boolean;
  paneId: string;
  label: string;
  hp: number;
  dying: number; // 0 = alive, else timestamp progress
  hitFlash: number;
  bubbleText: string | null;
  bubbleFetchedFor: string | null;
  phase: number;
}

function makeSprite(tex: THREE.Texture): THREE.Sprite {
  return new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
}

function emojiTexture(emoji: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.font = "96px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, 64, 72);
  return new THREE.CanvasTexture(c);
}

function healthTexture(hp: number, max: number, shield: boolean): THREE.CanvasTexture {
  const w = 200, h = 36;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, w, h);
  const seg = (w - 8) / max;
  for (let i = 0; i < max; i++) {
    ctx.fillStyle = shield ? "#38bdf8" : i < hp ? "#22c55e" : "#3f3f46";
    ctx.fillRect(4 + i * seg + 2, 6, seg - 4, h - 12);
  }
  return new THREE.CanvasTexture(c);
}

export function OfficeScene() {
  const mountRef = useRef<HTMLDivElement>(null);
  const { agents, connected } = useAgents();
  const agentsRef = useRef<Agent[]>([]);
  const officesRef = useRef<Map<string, Office>>(new Map());
  const hitboxesRef = useRef<THREE.Mesh[]>([]);
  const slotRef = useRef<Map<string, number>>(new Map());
  const sceneRef = useRef<THREE.Scene | null>(null);
  const [kills, setKills] = useState(0);
  const [locked, setLocked] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b12);
    scene.fog = new THREE.Fog(0x0b0b12, 30, 75);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      72, mount.clientWidth / mount.clientHeight, 0.1, 300,
    );
    camera.position.set(CELL * (COLS - 1) * 0.5, 1.7, (Math.ceil(8 / COLS)) * CELL + 6);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202028, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(14, 24, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50 });
    scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshStandardMaterial({ color: 0x16161f, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(300, 120, 0x2a2a3a, 0x1a1a24);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);

    // ---- weapon view-model (simple gun at bottom of view) ----
    const gun = new THREE.Group();
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x111118, roughness: 0.4, metalness: 0.6 });
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), gunMat);
    barrel.position.set(0.28, -0.26, -0.6);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.16), gunMat);
    grip.position.set(0.28, -0.42, -0.32);
    grip.rotation.x = 0.3;
    gun.add(barrel, grip);
    const muzzle = new THREE.PointLight(0xffaa33, 0, 6);
    muzzle.position.set(0.28, -0.26, -0.95);
    gun.add(muzzle);
    camera.add(gun);
    scene.add(camera);

    // ---- FPS controls ----
    let yaw = Math.PI, pitch = -0.12;
    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const dom = renderer.domElement;
    const onClickCanvas = () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock();
    };
    dom.addEventListener("click", onClickCanvas);
    const onLockChange = () => setLocked(document.pointerLockElement === dom);
    document.addEventListener("pointerlockchange", onLockChange);

    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== dom) return;
      yaw -= e.movementX * 0.0022;
      pitch = Math.max(-1.2, Math.min(0.5, pitch - e.movementY * 0.0022));
    };
    document.addEventListener("mousemove", onMouseMove);

    // ---- shooting ----
    const raycaster = new THREE.Raycaster();
    let recoil = 0;
    let tracer: THREE.Line | null = null;
    let tracerLife = 0;

    const shoot = () => {
      recoil = 1;
      muzzle.intensity = 4;
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const live = hitboxesRef.current.filter(
        (m) => m.userData.present && !m.userData.dead,
      );
      const hits = raycaster.intersectObjects(live, false);
      const origin = new THREE.Vector3();
      camera.getWorldPosition(origin);
      let end = origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(60));
      if (hits.length) {
        end = hits[0].point.clone();
        const office = officesRef.current.get(hits[0].object.userData.officeId as string);
        if (office) registerHit(office, hits[0].point);
      }
      // tracer
      if (tracer) scene.remove(tracer);
      const g = new THREE.BufferGeometry().setFromPoints([origin, end]);
      tracer = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffcc55, transparent: true }));
      scene.add(tracer);
      tracerLife = 1;
    };
    const onShootClick = () => {
      if (document.pointerLockElement === dom) shoot();
    };
    dom.addEventListener("mousedown", onShootClick);

    const registerHit = (office: Office, point: THREE.Vector3) => {
      office.hitFlash = 1;
      // spark
      const spark = new THREE.PointLight(0xffffff, 3, 4);
      spark.position.copy(point);
      scene.add(spark);
      setTimeout(() => scene.remove(spark), 80);

      if (office.focused) {
        // protect the controller agent — bullets bounce off a shield
        setHint("🛡️ that's the controller agent — it can't be killed");
        return;
      }
      if (office.hp <= 0 || office.dying) return;
      office.hp -= 1;
      office.healthBar.material.map = healthTexture(office.hp, MAX_HP, false);
      office.healthBar.material.needsUpdate = true;
      if (office.hp <= 0) killOffice(office);
    };

    const killOffice = (office: Office) => {
      office.dying = 0.001;
      office.hitbox.userData.dead = true;
      setKills((k) => k + 1);
      setHint(`☠️ killed ${office.label} — closing its herdr pane`);
      // ACTUALLY kill the agent in herdr
      herdr.kill(office.paneId).catch(() => {});
    };

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    // ---- loop ----
    const clock = new THREE.Clock();
    const forward = new THREE.Vector3();
    const rightV = new THREE.Vector3();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      // look
      camera.rotation.order = "YXZ";
      camera.rotation.y = yaw;
      camera.rotation.x = pitch;

      // move (WASD)
      const speed = (keys.has("ShiftLeft") ? 11 : 6) * dt;
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      rightV.set(Math.cos(yaw), 0, -Math.sin(yaw));
      if (keys.has("KeyW")) camera.position.addScaledVector(forward, speed);
      if (keys.has("KeyS")) camera.position.addScaledVector(forward, -speed);
      if (keys.has("KeyD")) camera.position.addScaledVector(rightV, speed);
      if (keys.has("KeyA")) camera.position.addScaledVector(rightV, -speed);
      camera.position.y = 1.7;
      camera.position.x = Math.max(-12, Math.min(COLS * CELL + 4, camera.position.x));
      camera.position.z = Math.max(-12, Math.min(Math.ceil(20 / COLS) * CELL + 14, camera.position.z));

      // gun recoil + muzzle decay
      recoil = Math.max(0, recoil - dt * 6);
      gun.position.z = recoil * 0.12;
      gun.rotation.x = recoil * 0.25;
      muzzle.intensity = Math.max(0, muzzle.intensity - dt * 30);
      if (tracer) {
        tracerLife -= dt * 5;
        (tracer.material as THREE.LineBasicMaterial).opacity = Math.max(0, tracerLife);
        if (tracerLife <= 0) { scene.remove(tracer); tracer = null; }
      }

      syncOffices(scene);
      for (const o of officesRef.current.values()) animateOffice(o, t, dt);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      dom.removeEventListener("click", onClickCanvas);
      dom.removeEventListener("mousedown", onShootClick);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildOffice(slot: number): Office {
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const baseX = col * CELL;
    const baseZ = -row * CELL;

    const group = new THREE.Group();
    group.position.set(baseX, 0, baseZ);

    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(CELL - 0.6, 0.1, CELL - 0.6),
      new THREE.MeshStandardMaterial({ color: 0x1e1e2a, roughness: 0.9 }),
    );
    tile.position.y = 0.05;
    tile.receiveShadow = true;
    group.add(tile);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b2b3a, roughness: 0.8 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(CELL - 0.6, 2.4, 0.18), wallMat);
    back.position.set(0, 1.2, -(CELL - 0.6) / 2);
    back.castShadow = back.receiveShadow = true;
    group.add(back);
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.4, CELL - 0.6), wallMat);
    side.position.set(-(CELL - 0.6) / 2, 1.2, 0);
    side.castShadow = true;
    group.add(side);

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

    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, emissive: 0x2266ff, emissiveIntensity: 0.4,
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
    character.position.set(0, 0, 0.1);
    group.add(character);

    // hitbox (invisible) used for raycasting
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 2.4, 1.0),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hitbox.position.set(0, 1.5, 0.1);
    hitbox.userData.officeId = `slot-${slot}`;
    character.add(hitbox);
    hitboxesRef.current.push(hitbox);

    const iconSprite = makeSprite(emojiTexture("·"));
    iconSprite.scale.set(0.9, 0.9, 0.9);
    iconSprite.position.set(0, 3.15, 0);
    group.add(iconSprite);

    const healthBar = makeSprite(healthTexture(MAX_HP, MAX_HP, false));
    healthBar.scale.set(1.6, 0.28, 1);
    healthBar.position.set(0, 2.75, 0);
    group.add(healthBar);

    sceneRef.current!.add(group);

    return {
      group, character, leftArm, rightArm, head, body, screenMat, bodyMat, chair,
      hitbox, healthBar, signSprite: null, iconSprite, bubbleSprite: null,
      baseX, baseZ, status: "unknown", present: false, focused: false, paneId: "",
      label: "", hp: MAX_HP, dying: 0, hitFlash: 0,
      bubbleText: null, bubbleFetchedFor: null, phase: Math.random() * Math.PI * 2,
    };
  }

  function syncOffices(scene: THREE.Scene) {
    const byOffice = new Map<string, Agent>();
    for (const a of agentsRef.current) byOffice.set(a.workspace_id || a.pane_id, a);

    for (const id of byOffice.keys()) {
      if (!slotRef.current.has(id)) slotRef.current.set(id, slotRef.current.size);
      if (!officesRef.current.has(id)) {
        const office = buildOffice(slotRef.current.get(id)!);
        office.hitbox.userData.officeId = id;
        officesRef.current.set(id, office);
      }
    }

    for (const [id, office] of officesRef.current) {
      const a = byOffice.get(id);
      const present = !!a && a.agent_status !== "unknown" && !office.dying;
      office.present = present;
      office.hitbox.userData.present = present;
      office.status = a?.agent_status ?? "unknown";
      office.focused = !!a?.focused;
      if (a) { office.paneId = a.pane_id; office.label = repoName(a); }

      // agent came back / new agent -> reset hp
      if (present && office.hp <= 0 && !office.dying) {
        office.hp = MAX_HP;
        office.healthBar.material.map = healthTexture(MAX_HP, MAX_HP, false);
        office.healthBar.material.needsUpdate = true;
        office.hitbox.userData.dead = false;
      }

      if (present && !office.signSprite) {
        const { texture, aspect } = makeLabelTexture(office.label, {
          bg: "#1e293b", border: "#475569", color: "#e2e8f0", size: 52,
        });
        const s = makeSprite(texture);
        s.scale.set(3.2, 3.2 / aspect, 1);
        s.position.set(0, 4.0, -(CELL - 0.6) / 2 + 0.2);
        office.signSprite = s;
        office.group.add(s);
      }
      if (office.signSprite) office.signSprite.visible = present;

      office.character.visible = present || office.dying > 0;
      office.iconSprite.visible = present;
      office.healthBar.visible = present;
      if (present) {
        office.bodyMat.color.setHex(STATUS_COLOR[office.status]);
        const want = STATUS_ICON[office.status];
        if (office.iconSprite.userData.emoji !== want) {
          office.iconSprite.userData.emoji = want;
          office.iconSprite.material.map = emojiTexture(want);
          office.iconSprite.material.needsUpdate = true;
        }
      }
      office.chair.position.z = present || office.dying ? 0.2 : -0.6;

      if (present && office.status === "done" && a) {
        if (office.bubbleFetchedFor !== a.pane_id) {
          office.bubbleFetchedFor = a.pane_id;
          herdr.bubble(a.pane_id)
            .then((r) => {
              office.bubbleText = r.message || "done ✓";
              if (office.bubbleSprite) { office.group.remove(office.bubbleSprite); office.bubbleSprite = null; }
            })
            .catch(() => { office.bubbleText = "done ✓"; });
        }
        if (office.bubbleText && !office.bubbleSprite) {
          const rtl = isHebrew(office.bubbleText);
          const { texture, aspect } = makeLabelTexture(office.bubbleText, {
            bg: "#fffbea", border: "#10b981", color: "#0a0a0a", size: 38, width: 560, rtl,
          });
          const s = makeSprite(texture);
          const h = 4.0 / aspect;
          s.scale.set(4.0, h, 1);
          s.position.set(1.7, 3.5 + h / 2, 0.4);
          office.bubbleSprite = s;
          office.group.add(s);
        }
      } else if (office.bubbleSprite) {
        office.group.remove(office.bubbleSprite);
        office.bubbleSprite = null;
        office.bubbleText = null;
        office.bubbleFetchedFor = null;
      }
    }
  }

  function animateOffice(o: Office, t: number, dt: number) {
    // death animation: collapse forward
    if (o.dying > 0) {
      o.dying = Math.min(1, o.dying + dt * 1.2);
      o.character.rotation.x = -o.dying * (Math.PI / 2);
      o.character.position.y = -o.dying * 0.3;
      (o.bodyMat as THREE.MeshStandardMaterial).color.lerpColors(
        new THREE.Color(0x7f1d1d), new THREE.Color(0x111111), o.dying,
      );
      if (o.dying >= 1) {
        o.character.visible = false;
        o.dying = 0;
        o.character.rotation.x = 0;
        o.character.position.y = 0;
      }
      return;
    }
    if (!o.present) { o.screenMat.emissiveIntensity = 0.04; return; }

    // hit flash
    if (o.hitFlash > 0) {
      o.hitFlash = Math.max(0, o.hitFlash - dt * 4);
      o.bodyMat.emissive.setHex(0xff3333);
      o.bodyMat.emissiveIntensity = o.hitFlash;
    } else {
      o.bodyMat.emissiveIntensity = 0;
    }

    const p = o.phase;
    o.group.position.x = o.baseX;
    o.character.rotation.z = 0;
    o.head.rotation.x = 0;
    o.body.rotation.x = 0;

    switch (o.status) {
      case "working":
        o.leftArm.rotation.x = -1.15 + Math.sin(t * 12 + p) * 0.4;
        o.rightArm.rotation.x = -1.15 + Math.sin(t * 12 + p + Math.PI) * 0.4;
        o.head.position.y = 2.25 + Math.sin(t * 6 + p) * 0.03;
        o.body.rotation.x = 0.16;
        o.screenMat.emissive.setHex(0x2266ff);
        o.screenMat.emissiveIntensity = 0.7 + Math.sin(t * 9 + p) * 0.25;
        break;
      case "idle":
        o.leftArm.rotation.x = -0.1;
        o.rightArm.rotation.x = -0.1;
        o.character.rotation.z = Math.sin(t * 1.1 + p) * 0.06;
        o.head.rotation.x = 0.35 + Math.sin(t * 0.8 + p) * 0.05;
        o.screenMat.emissive.setHex(0x223344);
        o.screenMat.emissiveIntensity = 0.15;
        break;
      case "blocked":
        o.leftArm.rotation.x = -1.6;
        o.rightArm.rotation.x = -1.6;
        o.group.position.x = o.baseX + Math.sin(t * 26 + p) * 0.025;
        o.screenMat.emissive.setHex(0xff5533);
        o.screenMat.emissiveIntensity = 0.5 + Math.sin(t * 14) * 0.3;
        break;
      case "done":
        o.leftArm.rotation.x = -0.2;
        o.rightArm.rotation.x = -0.2;
        o.body.rotation.x = -0.12;
        o.head.position.y = 2.25 + Math.sin(t * 2 + p) * 0.02;
        o.screenMat.emissive.setHex(0x10b981);
        o.screenMat.emissiveIntensity = 0.4;
        break;
    }
    o.iconSprite.position.y = 3.15 + Math.sin(t * 2 + p) * 0.12;
    // health bar shield tint for the protected controller agent
    if (o.focused) {
      o.healthBar.material.map = healthTexture(o.hp, MAX_HP, true);
      o.healthBar.material.needsUpdate = true;
    }
  }

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 2500);
    return () => clearTimeout(t);
  }, [hint]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={mountRef} className="h-full w-full cursor-none" />

      {/* crosshair */}
      {locked && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="relative h-6 w-6">
            <span className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 bg-white/80" />
            <span className="absolute bottom-0 left-1/2 h-2 w-px -translate-x-1/2 bg-white/80" />
            <span className="absolute top-1/2 left-0 h-px w-2 -translate-y-1/2 bg-white/80" />
            <span className="absolute top-1/2 right-0 h-px w-2 -translate-y-1/2 bg-white/80" />
            <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
          </div>
        </div>
      )}

      {/* HUD */}
      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 backdrop-blur">
        <div className="font-semibold text-zinc-100">🔫 herdr office — agent hunt</div>
        <div className="mt-1 text-zinc-400">
          {agents.length} desks · <span className={connected ? "text-emerald-400" : "text-amber-400"}>{connected ? "live" : "polling"}</span> · kills: <span className="text-red-400">{kills}</span>
        </div>
        <div className="mt-1 text-[10px] text-zinc-500">WASD move · mouse aim · click shoot · 3 hits = real kill</div>
      </div>

      {hint && (
        <div className="pointer-events-none absolute left-1/2 top-20 -translate-x-1/2 rounded-md bg-zinc-950/85 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          {hint}
        </div>
      )}

      {!locked && (
        <div
          className="absolute inset-0 grid cursor-pointer place-items-center bg-zinc-950/60 backdrop-blur-sm"
          onClick={() => mountRef.current?.querySelector("canvas")?.dispatchEvent(new MouseEvent("click"))}
        >
          <div className="text-center">
            <div className="text-2xl font-bold text-zinc-100">🔫 click to enter the office</div>
            <div className="mt-2 text-sm text-zinc-400">
              WASD to move · mouse to aim · click to shoot
            </div>
            <div className="mt-1 text-xs text-amber-400">
              shooting an agent 3× actually closes its herdr pane — for real
            </div>
            <div className="mt-3 text-[11px] text-zinc-500">press Esc to release the mouse</div>
          </div>
        </div>
      )}
    </div>
  );
}
