import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { merchantsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { errorResponse } from "../lib/response.js";

declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    errorResponse(res, "Missing or invalid Authorization header", "UNAUTHORIZED", 401);
    return;
  }

  const token = authHeader.slice(7);

  if (!token) {
    errorResponse(res, "Empty bearer token", "UNAUTHORIZED", 401);
    return;
  }

  const [merchant] = await db
    .select({ id: merchantsTable.id })
    .from(merchantsTable)
    .where(eq(merchantsTable.apiKey, token))
    .limit(1);

  if (!merchant) {
    errorResponse(res, "Invalid API key", "INVALID_API_KEY", 401);
    return;
  }

  req.merchantId = merchant.id;
  next();
}
