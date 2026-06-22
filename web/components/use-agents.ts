"use client";

import { useEffect, useRef, useState } from "react";
import { type Agent, herdr } from "@/lib/herdr";

// Live agent list via SSE, with a polling fallback if the stream drops.
export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (pollTimer) return;
      const tick = async () => {
        try {
          const { agents } = await herdr.agents();
          if (!stopped) {
            setAgents(agents);
            setError(null);
          }
        } catch (e) {
          if (!stopped) setError((e as Error).message);
        }
      };
      tick();
      pollTimer = setInterval(tick, 3000);
    };

    try {
      const es = new EventSource(herdr.streamUrl());
      esRef.current = es;
      es.onopen = () => {
        setConnected(true);
        setError(null);
      };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.agents) setAgents(data.agents);
        } catch {
          /* keepalive */
        }
      };
      es.onerror = () => {
        setConnected(false);
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      stopped = true;
      esRef.current?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  return { agents, connected, error };
}
