// Server-only bridge to the herdr native server.
//
// herdr exposes its API on an owner-only unix socket; the sanctioned client is
// the `herdr` CLI. These Next.js route handlers (Node runtime) shell out to it,
// so the browser talks same-origin HTTP/SSE and no separate process is needed.
import { spawn } from "node:child_process";

const HERDR_BIN = process.env.HERDR_BIN || "herdr";
const DEFAULT_TIMEOUT = 30_000;

export class HerdrError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseEnvelope(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Run `herdr <args>` and return the parsed `result` (or {ok:true} for the
// mutating commands that print nothing). Throws HerdrError on a CLI error
// envelope (which herdr prints to stderr) or a non-zero exit.
export function runHerdr(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(HERDR_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new HerdrError("herdr_not_found", String(e)));
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HerdrError("timeout", `herdr ${args.join(" ")} timed out`, 504));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new HerdrError("herdr_not_found", String(e)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const op = parseEnvelope(out);
      const ep = parseEnvelope(err);
      for (const p of [op, ep]) {
        if (p && p.error) {
          const e = p.error as { code?: string; message?: string };
          const notFound = ["agent_not_found", "not_found", "pane_not_found"].includes(
            e.code || "",
          );
          reject(new HerdrError(e.code || "error", e.message || "herdr error", notFound ? 404 : 502));
          return;
        }
      }
      if (code !== 0) {
        reject(new HerdrError("command_failed", err.trim() || out.trim() || `exit ${code}`));
        return;
      }
      if (op && "result" in op) resolve(op.result as Record<string, unknown>);
      else if (op) resolve(op);
      else resolve(out.trim() ? { ok: true, text: out.trim() } : { ok: true });
    });
  });
}

// JSON Response + HerdrError -> proper HTTP status.
export function ok(data: unknown): Response {
  return Response.json(data);
}
export function fail(e: unknown): Response {
  if (e instanceof HerdrError) {
    return Response.json({ detail: { code: e.code, message: e.message } }, { status: e.status });
  }
  return Response.json({ detail: { code: "internal", message: String(e) } }, { status: 500 });
}

// Best-effort "last message" for a done agent, for office speech bubbles.
const UI_NOISE = [
  "⏵", "❯", "bypass permissions", "new task?", "/clear", "/rc",
  "shift+tab", "for agents", "esc to interrupt", "ctrl+",
];
export function extractBubble(text: string, maxChars = 280): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("※ recap:")) {
      let msg = s.slice("※ recap:".length).trim();
      const next = lines[i + 1]?.trim();
      if (next && !lines[i + 1].startsWith("─")) msg += " " + next;
      return clip(msg, maxChars);
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].replace(/─+/g, "").trim();
    if (!s || s.length < 4) continue;
    const low = s.toLowerCase();
    if ([..."".concat(s)].every((c) => "─═—· ".includes(c))) continue;
    if (UI_NOISE.some((n) => low.includes(n))) continue;
    return clip(s, maxChars);
  }
  return "";
}
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
