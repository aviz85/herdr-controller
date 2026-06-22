import * as THREE from "three";

// Render wrapped text onto a canvas and return a THREE texture.
// Used for project signs and "done" speech bubbles.
export function makeLabelTexture(
  text: string,
  {
    width = 512,
    pad = 28,
    font = 600,
    size = 46,
    color = "#0a0a0a",
    bg = "#fde68a",
    border = "#f59e0b",
    rtl = false,
  }: {
    width?: number;
    pad?: number;
    font?: number;
    size?: number;
    color?: string;
    bg?: string;
    border?: string;
    rtl?: boolean;
  } = {},
): { texture: THREE.CanvasTexture; aspect: number } {
  const dpr = 2;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const fontStr = `${font} ${size}px ui-sans-serif, system-ui, sans-serif`;

  // word-wrap
  ctx.font = fontStr;
  const maxText = width - pad * 2;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxText && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const lineH = size * 1.28;
  const height = Math.ceil(pad * 2 + lines.length * lineH);

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // rounded card
  const r = 22;
  ctx.fillStyle = bg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 6;
  roundRect(ctx, 3, 3, width - 6, height - 6, r);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = fontStr;
  ctx.textBaseline = "middle";
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";
  const x = rtl ? width - pad : pad;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, x, pad + lineH * (i + 0.5));
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return { texture, aspect: width / height };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function isHebrew(s: string): boolean {
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) return /[֐-׿]/.test(ch);
  }
  return false;
}
