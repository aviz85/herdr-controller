import { runHerdr, ok, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ target: string }> },
) {
  try {
    const { target } = await params;
    const body = (await req.json()) as { text?: string; enter?: boolean };
    const text = body.text ?? "";
    // enter=true -> `pane run` (text + Enter); else `agent send` (literal text)
    const args = body.enter ? ["pane", "run", target, text] : ["agent", "send", target, text];
    await runHerdr(args);
    return ok({ ok: true, target });
  } catch (e) {
    return fail(e);
  }
}
