import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { simulations } from "../../../db/schema";

function userId(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

function advance<T extends typeof simulations.$inferSelect>(run: T): T {
  if (run.status === "completed" || run.status === "failed") return run;
  const elapsed = Date.now() - new Date(run.createdAt).getTime();
  const progress = Math.min(100, Math.max(run.progress, Math.floor(elapsed / 1800)));
  return { ...run, progress, status: progress >= 100 ? "completed" : progress > 4 ? "running" : "queued", endSoh: progress >= 100 ? Number((84.6 - run.horizonYears * 0.17 - run.cyclesPerDay * 0.4).toFixed(1)) : null };
}

export async function GET(request: Request) {
  const owner = userId(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const db = getDb();
  const rows = await db.select().from(simulations).where(eq(simulations.userId, owner)).orderBy(desc(simulations.createdAt)).limit(30);
  const advanced = rows.map(advance);
  for (const run of advanced) {
    const previous = rows.find((row) => row.id === run.id);
    if (previous && (run.progress !== previous.progress || run.status !== previous.status)) {
      await db.update(simulations).set({ progress: run.progress, status: run.status, endSoh: run.endSoh, updatedAt: new Date().toISOString() }).where(and(eq(simulations.id, run.id), eq(simulations.userId, owner)));
    }
  }
  return Response.json({ simulations: advanced });
}

export async function POST(request: Request) {
  const owner = userId(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const payload = (await request.json()) as { name?: string; chemistry?: string; horizonYears?: number; cyclesPerDay?: number };
  const name = payload.name?.trim();
  const horizonYears = Math.min(25, Math.max(1, Number(payload.horizonYears ?? 20)));
  const cyclesPerDay = Math.min(3, Math.max(0.25, Number(payload.cyclesPerDay ?? 1)));
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  const now = new Date().toISOString();
  const simulation = { id: `ESS-${Date.now().toString(36).toUpperCase()}`, userId: owner, name, chemistry: payload.chemistry ?? "LFP", horizonYears, cyclesPerDay, status: "queued", progress: 0, endSoh: null, createdAt: now, updatedAt: now };
  const db = getDb();
  await db.insert(simulations).values(simulation);
  return Response.json({ simulation }, { status: 201 });
}
