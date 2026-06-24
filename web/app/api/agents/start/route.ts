import { runHerdr, ok, fail } from "@/lib/herdr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as {
      name?: string;
      cwd?: string;
      workspace?: string;
      tab?: string;
      split?: string;
      focus?: boolean;
      argv?: string[];
    };
    const args = ["agent", "start", b.name ?? "claude"];
    if (b.cwd) args.push("--cwd", b.cwd);
    if (b.workspace) args.push("--workspace", b.workspace);
    if (b.tab) args.push("--tab", b.tab);
    if (b.split) args.push("--split", b.split);
    args.push(b.focus === false ? "--no-focus" : "--focus");
    if (b.argv?.length) args.push("--", ...b.argv);
    return ok(await runHerdr(args));
  } catch (e) {
    return fail(e);
  }
}
