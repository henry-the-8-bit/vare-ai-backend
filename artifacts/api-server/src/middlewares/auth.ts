import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { merchantsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { errorResponse } from "../lib/response.js";

declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
      merchantSlug?: string;
      agentPlatform?: string;
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

export async function requireAgentAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const slug = req.params["merchant_slug"] as string | undefined;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    errorResponse(res, "Missing or invalid Authorization header. Use: Bearer <api_key>", "UNAUTHORIZED", 401);
    return;
  }

  const token = authHeader.slice(7);
  if (!token) {
    errorResponse(res, "Empty bearer token", "UNAUTHORIZED", 401);
    return;
  }

  if (!slug) {
    errorResponse(res, "Missing merchant slug in URL path", "BAD_REQUEST", 400);
    return;
  }

  const [merchant] = await db
    .select({ id: merchantsTable.id, slug: merchantsTable.slug })
    .from(merchantsTable)
    .where(and(eq(merchantsTable.apiKey, token), eq(merchantsTable.slug, slug)))
    .limit(1);

  if (!merchant) {
    errorResponse(res, "Invalid API key or merchant slug mismatch", "INVALID_API_KEY", 401);
    return;
  }

  req.merchantId = merchant.id;
  req.merchantSlug = merchant.slug ?? slug;
  req.agentPlatform = (req.headers["x-agent-platform"] as string | undefined) ?? "api";
  next();
}
