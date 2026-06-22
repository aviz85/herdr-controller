// Client for the herdr-controller FastAPI backend.

export const API_BASE =
  process.env.NEXT_PUBLIC_HERDR_API ?? "http://127.0.0.1:8791";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Agent {
  agent?: string;
  agent_status: AgentStatus;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  terminal_id?: string;
  agent_session?: { value?: string };
}

export interface Summary {
  total_agents: number;
  by_status: Partial<Record<AgentStatus, number>>;
  workspaces: number;
  focused_agent: Agent | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = (await res.json())?.detail;
    } catch {
      detail = await res.text();
    }
    const msg =
      typeof detail === "object" && detail && "message" in detail
        ? (detail as { message: string }).message
        : String(detail);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const ct = res.headers.get("content-type") || "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const herdr = {
  summary: () => req<Summary>("/summary"),
  agents: () => req<{ agents: Agent[]; count: number }>("/agents"),
  read: (target: string, lines = 200) =>
    req<string>(`/agents/${encodeURIComponent(target)}/read?lines=${lines}`),
  bubble: (target: string) =>
    req<{ target: string; message: string }>(
      `/agents/${encodeURIComponent(target)}/bubble`,
    ),
  send: (target: string, text: string, enter: boolean) =>
    req(`/agents/${encodeURIComponent(target)}/send`, {
      method: "POST",
      body: JSON.stringify({ text, enter }),
    }),
  focus: (target: string) =>
    req(`/agents/${encodeURIComponent(target)}/focus`, { method: "POST" }),
  start: (body: Record<string, unknown>) =>
    req("/agents/start", { method: "POST", body: JSON.stringify(body) }),
  // Closes the agent's pane in herdr — i.e. actually kills the agent.
  kill: (paneId: string) =>
    req(`/panes/${encodeURIComponent(paneId)}`, { method: "DELETE" }),
  streamUrl: () => `${API_BASE}/agents/stream`,
};

export const STATUS_META: Record<
  AgentStatus,
  { label: string; dot: string; badge: string }
> = {
  working: {
    label: "Working",
    dot: "bg-blue-500",
    badge: "border-blue-500/30 bg-blue-500/10 text-blue-400",
  },
  idle: {
    label: "Idle",
    dot: "bg-zinc-500",
    badge: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
  },
  blocked: {
    label: "Blocked",
    dot: "bg-amber-500",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  },
  done: {
    label: "Done",
    dot: "bg-emerald-500",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  },
  unknown: {
    label: "Unknown",
    dot: "bg-zinc-700",
    badge: "border-zinc-700/40 bg-zinc-700/10 text-zinc-500",
  },
};

export function repoName(a: Agent): string {
  const p = a.cwd || a.foreground_cwd || "";
  return p.split("/").filter(Boolean).pop() || a.pane_id;
}
