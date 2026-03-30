import { db } from "@workspace/db";
import { systemAlertsTable } from "@workspace/db/schema";
import { eq, and, desc, sql, isNull, lt } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export type AlertSeverity = "critical" | "error" | "warning" | "info";
export type AlertCategory =
  | "sync"
  | "connection"
  | "inventory"
  | "normalization"
  | "fitment"
  | "gateway"
  | "distribution"
  | "system";
export type RelatedEntityType = "feed" | "job" | "order" | "product" | "connection";

export interface CreateAlertInput {
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  description: string;
  suggestion?: string;
  source?: string;
  relatedEntityId?: string;
  relatedEntityType?: RelatedEntityType;
  expiresAt?: Date;
}

/**
 * Map severity to the legacy alertType field for backward compatibility.
 */
function severityToAlertType(severity: AlertSeverity): string {
  switch (severity) {
    case "critical":
      return "error";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

// ── Create ──

export async function createAlert(
  merchantId: string,
  input: CreateAlertInput,
): Promise<string> {
  const [alert] = await db
    .insert(systemAlertsTable)
    .values({
      merchantId,
      alertType: severityToAlertType(input.severity),
      severity: input.severity,
      category: input.category,
      source: input.source ?? null,
      title: input.title,
      description: input.description,
      suggestion: input.suggestion ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      relatedEntityType: input.relatedEntityType ?? null,
      expiresAt: input.expiresAt ?? null,
      isRead: false,
    })
    .returning({ id: systemAlertsTable.id });

  logger.info(
    { merchantId, alertId: alert.id, severity: input.severity, category: input.category },
    `[notifications] Alert created: ${input.title}`,
  );

  return alert.id;
}

/**
 * Convenience wrapper: create an alert from a caught error with context.
 */
export async function createAlertFromError(
  merchantId: string,
  error: unknown,
  context: {
    category: AlertCategory;
    source: string;
    severity?: AlertSeverity;
    relatedEntityId?: string;
    relatedEntityType?: RelatedEntityType;
  },
): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "Error";

  return createAlert(merchantId, {
    severity: context.severity ?? "error",
    category: context.category,
    title: `${context.source}: ${errorName}`,
    description: message,
    suggestion: getSuggestionForError(message, context.category),
    source: context.source,
    relatedEntityId: context.relatedEntityId,
    relatedEntityType: context.relatedEntityType,
  });
}

// ── Read ──

export interface GetAlertsOptions {
  unread?: boolean;
  category?: AlertCategory;
  severity?: AlertSeverity;
  limit?: number;
  offset?: number;
}

export async function getAlerts(merchantId: string, options: GetAlertsOptions = {}) {
  const conditions = [
    eq(systemAlertsTable.merchantId, merchantId),
    isNull(systemAlertsTable.dismissedAt),
  ];

  if (options.unread) {
    conditions.push(eq(systemAlertsTable.isRead, false));
  }
  if (options.category) {
    conditions.push(eq(systemAlertsTable.category, options.category));
  }
  if (options.severity) {
    conditions.push(eq(systemAlertsTable.severity, options.severity));
  }

  const alerts = await db
    .select()
    .from(systemAlertsTable)
    .where(and(...conditions))
    .orderBy(desc(systemAlertsTable.createdAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  return alerts;
}

export async function getUnreadCount(merchantId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(systemAlertsTable)
    .where(
      and(
        eq(systemAlertsTable.merchantId, merchantId),
        eq(systemAlertsTable.isRead, false),
        isNull(systemAlertsTable.dismissedAt),
      ),
    );

  return result?.count ?? 0;
}

// ── Update ──

export async function markAsRead(merchantId: string, alertId: string): Promise<boolean> {
  const result = await db
    .update(systemAlertsTable)
    .set({ isRead: true })
    .where(
      and(
        eq(systemAlertsTable.id, alertId),
        eq(systemAlertsTable.merchantId, merchantId),
      ),
    )
    .returning({ id: systemAlertsTable.id });

  return result.length > 0;
}

export async function markAllAsRead(
  merchantId: string,
  category?: AlertCategory,
): Promise<number> {
  const conditions = [
    eq(systemAlertsTable.merchantId, merchantId),
    eq(systemAlertsTable.isRead, false),
  ];

  if (category) {
    conditions.push(eq(systemAlertsTable.category, category));
  }

  const result = await db
    .update(systemAlertsTable)
    .set({ isRead: true })
    .where(and(...conditions))
    .returning({ id: systemAlertsTable.id });

  return result.length;
}

// ── Delete / Dismiss ──

export async function dismissAlert(merchantId: string, alertId: string): Promise<boolean> {
  const result = await db
    .update(systemAlertsTable)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(systemAlertsTable.id, alertId),
        eq(systemAlertsTable.merchantId, merchantId),
      ),
    )
    .returning({ id: systemAlertsTable.id });

  return result.length > 0;
}

export async function deleteOldAlerts(merchantId: string, olderThanDays = 30): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const result = await db
    .delete(systemAlertsTable)
    .where(
      and(
        eq(systemAlertsTable.merchantId, merchantId),
        lt(systemAlertsTable.createdAt, cutoff),
      ),
    )
    .returning({ id: systemAlertsTable.id });

  return result.length;
}

// ── Helpers ──

function getSuggestionForError(message: string, category: AlertCategory): string {
  const lower = message.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Check your store's API response times. Consider increasing timeout thresholds or checking server load.";
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("credentials")) {
    return "Your API credentials may be invalid or expired. Re-enter your credentials in the connection settings.";
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission")) {
    return "The API user lacks required permissions. Check the integration user's role and resource access in your store admin.";
  }
  if (lower.includes("ssl") || lower.includes("certificate")) {
    return "There is an SSL certificate issue with your store. Verify your SSL certificate is valid and not expired.";
  }
  if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return "Unable to reach your store. Check that the store URL is correct and the server is accessible.";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "API rate limit reached. The system will retry automatically. Consider adjusting sync frequency.";
  }

  switch (category) {
    case "sync":
      return "Review the sync error log for details. You can retry the sync from the feeds page.";
    case "connection":
      return "Test your connection from the settings page. Re-enter credentials if needed.";
    case "inventory":
      return "Check inventory probe configuration. The system will use the configured fallback behavior.";
    case "normalization":
      return "Some products could not be normalized. Review the normalization preview for details.";
    case "fitment":
      return "Fitment extraction encountered issues. Check product descriptions for structured fitment data.";
    case "gateway":
      return "Order processing failed. Check gateway configuration and test with a new order.";
    case "distribution":
      return "Distribution sync failed. Check the platform configuration and try re-syncing.";
    default:
      return "Check the system status and try again. Contact support if the issue persists.";
  }
}
