import { runHerdr } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-Sent Events: push the agent list whenever any status changes.
export async function GET(req: Request) {
  const intervalMs =
    Math.min(30, Math.max(0.5, Number(new URL(req.url).searchParams.get("interval") || 2))) * 1000;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      let last = "";
      const tick = async () => {
        if (closed) return;
        try {
          const res = await runHerdr(["agent", "list"]);
          const agents = (res.agents as Record<string, unknown>[]) ?? [];
          const snap = JSON.stringify(agents.map((a) => [a.pane_id, a.agent_status]));
          if (snap !== last) {
            last = snap;
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ agents })}\n\n`));
          } else {
            controller.enqueue(enc.encode(`: keepalive\n\n`));
          }
        } catch (e) {
          const err = e as { code?: string; message?: string };
          controller.enqueue(
            enc.encode(`event: error\ndata: ${JSON.stringify({ code: err.code, message: err.message })}\n\n`),
          );
        }
        if (!closed) timer = setTimeout(tick, intervalMs);
      };
      tick();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  req.signal.addEventListener("abort", () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
