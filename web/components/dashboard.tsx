"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Agent, type AgentStatus, STATUS_META, repoName } from "@/lib/herdr";
import { useAgents } from "@/components/use-agents";
import { TerminalPanel } from "@/components/terminal-panel";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { Card } from "@/components/ui/card";

const ORDER: AgentStatus[] = ["working", "blocked", "done", "idle", "unknown"];

function StatPill({ status, count }: { status: AgentStatus; count: number }) {
  const m = STATUS_META[status];
  return (
    <div className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1">
      <span className={`size-2 rounded-full ${m.dot}`} />
      <span className="text-sm font-medium text-zinc-200">{count}</span>
      <span className="text-xs text-zinc-500">{m.label}</span>
    </div>
  );
}

function AgentCard({
  agent,
  selected,
  onClick,
}: {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
}) {
  const m = STATUS_META[agent.agent_status];
  const pulse = agent.agent_status === "working";
  return (
    <Card
      onClick={onClick}
      className={`cursor-pointer gap-2 border-zinc-800 bg-zinc-900/50 p-4 transition-all hover:border-zinc-700 hover:bg-zinc-900 ${
        selected ? "border-zinc-500 ring-1 ring-zinc-500/40" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-semibold text-zinc-100">
          {repoName(agent)}
        </span>
        <span className="relative flex size-2.5">
          {pulse && (
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${m.dot}`} />
          )}
          <span className={`relative inline-flex size-2.5 rounded-full ${m.dot}`} />
        </span>
      </div>
      <p className="truncate font-mono text-[11px] text-zinc-500">{agent.cwd}</p>
      <div className="flex items-center justify-between">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${m.badge}`}>
          {m.label}
        </span>
        <span className="font-mono text-[10px] text-zinc-600">
          {agent.focused ? "● focused" : agent.pane_id}
        </span>
      </div>
    </Card>
  );
}

// Draggable split between the agent picker and the terminal.
function useSplitter(initial = 45) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(initial);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const saved = Number(localStorage.getItem("herdr.split"));
    if (saved >= 15 && saved <= 85) setPct(saved);
  }, []);

  const onMove = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = Math.min(85, Math.max(15, ((clientX - r.left) / r.width) * 100));
    setPct(next);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onMove(e.clientX);
    const up = () => {
      setDragging(false);
      setPct((p) => {
        localStorage.setItem("herdr.split", String(Math.round(p)));
        return p;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, onMove]);

  return { containerRef, pct, dragging, startDrag: () => setDragging(true) };
}

export function Dashboard() {
  const { agents, connected, error } = useAgents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { containerRef, pct, dragging, startDrag } = useSplitter();

  const sorted = useMemo(
    () =>
      [...agents].sort(
        (a, b) =>
          ORDER.indexOf(a.agent_status) - ORDER.indexOf(b.agent_status) ||
          repoName(a).localeCompare(repoName(b)),
      ),
    [agents],
  );

  const counts = useMemo(() => {
    const c = {} as Record<AgentStatus, number>;
    for (const s of ORDER) c[s] = 0;
    for (const a of agents) c[a.agent_status] = (c[a.agent_status] ?? 0) + 1;
    return c;
  }, [agents]);

  const selected = agents.find((a) => a.pane_id === selectedId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-lg">
            🐑
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">herdr · agents</h1>
            <p className="text-xs text-zinc-500">
              {agents.length} agents ·{" "}
              <span className={connected ? "text-emerald-400" : "text-amber-400"}>
                {connected ? "live (SSE)" : "polling"}
              </span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ORDER.filter((s) => counts[s] > 0).map((s) => (
            <StatPill key={s} status={s} count={counts[s]} />
          ))}
          <NewAgentDialog />
        </div>
      </header>

      {error && (
        <div className="border-b border-amber-900/50 bg-amber-950/40 px-6 py-2 text-xs text-amber-300">
          API error: {error} — is the herdr-controller backend running on{" "}
          <code>:8791</code>?
        </div>
      )}

      {/* Body: agent grid + draggable splitter + terminal */}
      <div
        ref={containerRef}
        className={`flex min-h-0 flex-1 ${dragging ? "cursor-col-resize select-none" : ""}`}
      >
        <section
          style={{ width: `${pct}%` }}
          className="min-h-0 min-w-0 shrink-0 overflow-auto p-4"
        >
          {sorted.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-zinc-600">
              No agents detected
            </div>
          ) : (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {sorted.map((a) => (
                <AgentCard
                  key={a.pane_id}
                  agent={a}
                  selected={a.pane_id === selectedId}
                  onClick={() => setSelectedId(a.pane_id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Drag handle */}
        <div
          onPointerDown={(e) => {
            e.preventDefault();
            startDrag();
          }}
          onDoubleClick={() => {
            localStorage.setItem("herdr.split", "45");
            location.reload();
          }}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          className={`group relative w-px shrink-0 cursor-col-resize bg-zinc-800 transition-colors hover:bg-indigo-500 ${
            dragging ? "bg-indigo-500" : ""
          }`}
        >
          <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>

        <section className="min-h-0 min-w-0 flex-1">
          <TerminalPanel agent={selected} />
        </section>
      </div>
    </div>
  );
}
