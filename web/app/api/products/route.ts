import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { cellProducts } from "../../../db/schema";
import { parseProductInput } from "../../../lib/catalog";

function ownerOf(request: Request) { return request.headers.get("oai-authenticated-user-id"); }

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const products = await getDb().select().from(cellProducts).where(eq(cellProducts.userId, owner)).orderBy(desc(cellProducts.createdAt));
  return Response.json({ products });
}

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: "request body must be valid JSON" }, { status: 400 }); }
  const parsed = parseProductInput(payload);
  if (!parsed.ok) return Response.json({ error: "invalid request", details: parsed.errors }, { status: 400 });
  const product = { id: crypto.randomUUID(), userId: owner, ...parsed.value, status: "draft", createdAt: new Date().toISOString() };
  try { await getDb().insert(cellProducts).values(product); }
  catch { return Response.json({ error: "A product with this model and revision already exists" }, { status: 409 }); }
  return Response.json({ product }, { status: 201 });
}
