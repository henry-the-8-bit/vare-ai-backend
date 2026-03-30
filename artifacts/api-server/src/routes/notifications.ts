import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { successResponse, errorResponse } from "../lib/response.js";
import {
  getAlerts,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  dismissAlert,
  deleteOldAlerts,
  type AlertCategory,
  type AlertSeverity,
} from "../services/notificationService.js";

const router = Router();

// ── GET /notifications — List notifications (paginated, filterable) ──
router.get("/notifications", requireAuth, async (req: Request, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    const unread = req.query["unread"] === "true" ? true : undefined;
    const category = req.query["category"] as AlertCategory | undefined;
    const severity = req.query["severity"] as AlertSeverity | undefined;
    const limit = Math.min(parseInt(req.query["limit"] as string) || 50, 100);
    const offset = parseInt(req.query["offset"] as string) || 0;

    const alerts = await getAlerts(merchantId, { unread, category, severity, limit, offset });
    successResponse(res, alerts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorResponse(res, msg, "INTERNAL_ERROR", 500);
  }
});

// ── GET /notifications/unread-count — Fast unread count for badge ──
router.get("/notifications/unread-count", requireAuth, async (req: Request, res: Response) => {
  try {
    const count = await getUnreadCount(req.merchantId!);
    successResponse(res, { count });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorResponse(res, msg, "INTERNAL_ERROR", 500);
  }
});

// ── PATCH /notifications/:id/read — Mark single notification as read ──
router.patch("/notifications/:id/read", requireAuth, async (req: Request, res: Response) => {
  try {
    const updated = await markAsRead(req.merchantId!, req.params.id);
    if (!updated) {
      errorResponse(res, "Notification not found", "NOT_FOUND", 404);
      return;
    }
    successResponse(res, { success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorResponse(res, msg, "INTERNAL_ERROR", 500);
  }
});

// ── POST /notifications/mark-all-read — Mark all (or by category) as read ──
router.post("/notifications/mark-all-read", requireAuth, async (req: Request, res: Response) => {
  try {
    const category = req.body?.category as AlertCategory | undefined;
    const count = await markAllAsRead(req.merchantId!, category);
    successResponse(res, { updated: count });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorResponse(res, msg, "INTERNAL_ERROR", 500);
  }
});

// ── DELETE /notifications/:id — Dismiss a notification ──
router.delete("/notifications/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const dismissed = await dismissAlert(req.merchantId!, req.params.id);
    if (!dismissed) {
      errorResponse(res, "Notification not found", "NOT_FOUND", 404);
      return;
    }
    successResponse(res, { success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorResponse(res, msg, "INTERNAL_ERROR", 500);
  }
});

// ── POST /notifications/cleanup — Delete old notifications ──
router.post("/notifications/cleanup", requireAuth, async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.body?.olderThanDays) || 30;
    const deleted = await deleteOldAlerts(req.merchantId!, days);
    successResponse(res, { deleted });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errorResponse(res, msg, "INTERNAL_ERROR", 500);
  }
});

export default router;
