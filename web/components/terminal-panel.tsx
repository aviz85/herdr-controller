"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Agent, STATUS_META, herdr, repoName } from "@/lib/herdr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

// Direction of a single line: RTL only when the first *letter* (skipping
// digits, punctuation, whitespace, box-drawing, emoji) is a Hebrew letter.
function lineDir(line: string): "rtl" | "ltr" {
  for (const ch of line) {
    if (/\p{L}/u.test(ch)) {
      return /[֐-׿]/.test(ch) ? "rtl" : "ltr";
    }
  }
  return "ltr";
}

export function TerminalPanel({ agent }: { agent: Agent | null }) {
  const [text, setText] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!agent) return;
    setLoading(true);
    try {
      const out = await herdr.read(agent.pane_id, 300);
      setText(typeof out === "string" ? out : JSON.stringify(out));
    } catch (e) {
      setText(`⚠ ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [agent]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  const send = async (enter: boolean) => {
    if (!agent || !input.trim()) return;
    setSending(true);
    try {
      await herdr.send(agent.pane_id, input, enter);
      toast.success(enter ? "Sent + Enter" : "Typed into agent");
      setInput("");
      setTimeout(refresh, 400);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Select an agent to view its terminal
      </div>
    );
  }

  const meta = STATUS_META[agent.agent_status];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-zinc-100">
              {repoName(agent)}
            </h2>
            <Badge variant="outline" className={meta.badge}>
              <span className={`mr-1 size-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </Badge>
          </div>
          <p className="truncate font-mono text-xs text-zinc-500">
            {agent.pane_id} · {agent.cwd}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => herdr.focus(agent.pane_id).then(() => toast.success("Focused in herdr"))}
          >
            Focus
          </Button>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            {loading ? "…" : "Refresh"}
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-black/40 p-4 font-mono text-[12px] leading-relaxed text-zinc-300"
      >
        {text ? (
          text.split("\n").map((line, i) => {
            const dir = lineDir(line);
            return (
              <div
                key={i}
                dir={dir}
                className={`whitespace-pre-wrap break-words ${dir === "rtl" ? "text-right" : "text-left"}`}
              >
                {line || " "}
              </div>
            );
          })
        ) : (
          <span>—</span>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-800 p-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(true);
            }
          }}
          placeholder="Message this agent…"
          className="font-mono"
        />
        <Button variant="secondary" disabled={sending} onClick={() => send(false)}>
          Type
        </Button>
        <Button disabled={sending} onClick={() => send(true)}>
          Send ⏎
        </Button>
      </div>
    </div>
  );
}
