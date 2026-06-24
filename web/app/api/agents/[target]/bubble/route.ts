import { runHerdr, ok, fail, extractBubble } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ target: string }> },
) {
  try {
    const { target } = await params;
    const res = await runHerdr(["agent", "read", target, "--source", "recent-unwrapped", "--lines", "60"]);
    const text = ((res.read as { text?: string })?.text) ?? "";
    return ok({ target, message: extractBubble(text) });
  } catch (e) {
    return fail(e);
  }
}
