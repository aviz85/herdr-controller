import { runHerdr, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ target: string }> },
) {
  try {
    const { target } = await params;
    const sp = new URL(req.url).searchParams;
    const source = sp.get("source") ?? "recent";
    const lines = String(Math.min(2000, Math.max(1, Number(sp.get("lines") || 50))));
    const res = await runHerdr(["agent", "read", target, "--source", source, "--lines", lines]);
    const text = ((res.read as { text?: string })?.text) ?? "";
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return fail(e);
  }
}
