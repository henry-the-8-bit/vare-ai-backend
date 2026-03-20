import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { merchantsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { successResponse, errorResponse } from "../lib/response.js";

const router: IRouter = Router();

router.get("/health", async (_req: Request, res: Response) => {
  const checks: Record<string, unknown> = {};

  try {
    const result = await db.execute(sql`SELECT 1 AS db_ok`);
    checks["database"] = { status: "ok", result: result.rows[0] };
  } catch (err) {
    checks["database"] = { status: "error", error: String(err) };
    errorResponse(res, "Database health check failed", "DB_ERROR", 503, checks);
    return;
  }

  try {
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(merchantsTable);
    checks["merchants_table"] = { status: "ok", count: count[0]?.count };
  } catch (err) {
    checks["merchants_table"] = { status: "error", error: String(err) };
  }

  checks["env"] = {
    vare_api_secret: Boolean(process.env["VARE_API_SECRET"]),
    encryption_key: Boolean(process.env["ENCRYPTION_KEY"]),
    database_url: Boolean(process.env["DATABASE_URL"]),
  };

  successResponse(res, {
    status: "ok",
    checks,
    timestamp: new Date().toISOString(),
  });
});

export default router;
