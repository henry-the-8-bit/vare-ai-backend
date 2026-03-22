import { db } from "@workspace/db";
import {
  merchantsTable,
  magentoConnectionsTable,
  storeViewsTable,
  syncJobsTable,
  normalizedProductsTable,
  attributeMappingsTable,
  agentConfigsTable,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";

export interface PhaseChecklistItem {
  phase: number;
  label: string;
  description: string;
  complete: boolean;
  nextAction?: string;
}

export interface OnboardingPhaseResult {
  currentPhase: number;
  totalPhases: number;
  label: string;
  percentComplete: number;
  isLive: boolean;
  nextPhase: number | null;
  nextLabel: string | null;
  nextAction: string | null;
  checklist: PhaseChecklistItem[];
}

const PHASE_LABELS: Record<number, string> = {
  1: "Merchant Profile",
  2: "Magento Credentials",
  3: "Connection Verified",
  4: "Store Views Selected",
  5: "Sync Configured",
  6: "Catalog Synced",
  7: "Products Normalized",
  8: "Attribute Mapping",
  9: "Agent Configured",
  10: "Live",
};

const PHASE_DESCRIPTIONS: Record<number, string> = {
  1: "Basic merchant profile and contact information",
  2: "Magento API credentials saved securely",
  3: "Magento connection tested and verified",
  4: "Store views reviewed and selected",
  5: "Catalog sync filters configured",
  6: "Full product catalog synced from Magento",
  7: "Normalized products available for agent queries",
  8: "Attribute mappings discovered and approved",
  9: "Slug, API key, and agent settings configured",
  10: "Merchant is live and accepting agent orders",
};

const PHASE_NEXT_ACTIONS: Record<number, string> = {
  1: "",
  2: "POST /api/onboarding/connect",
  3: "POST /api/onboarding/connect/test",
  4: "PATCH /api/onboarding/connect/store-views",
  5: "POST /api/onboarding/sync/configure",
  6: "POST /api/onboarding/sync/start",
  7: "POST /api/onboarding/normalization/run",
  8: "POST /api/onboarding/normalization/attribute-mappings/discover",
  9: "POST /api/onboarding/agent-config/set-slug",
  10: "POST /api/onboarding/activate",
};

export async function computeOnboardingPhase(merchantId: string): Promise<OnboardingPhaseResult> {
  const [merchant] = await db
    .select({
      id: merchantsTable.id,
      slug: merchantsTable.slug,
      isLive: merchantsTable.isLive,
    })
    .from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId))
    .limit(1);

  if (!merchant) {
    throw new Error("Merchant not found");
  }

  const [
    [connRow],
    storeViews,
    [syncJobRow],
    [productRow],
    [mappingRow],
    [agentCfgRow],
  ] = await Promise.all([
    db
      .select({
        connectionStatus: magentoConnectionsTable.connectionStatus,
        syncConfig: magentoConnectionsTable.syncConfig,
      })
      .from(magentoConnectionsTable)
      .where(eq(magentoConnectionsTable.merchantId, merchantId))
      .limit(1),
    db
      .select({ id: storeViewsTable.id })
      .from(storeViewsTable)
      .where(and(eq(storeViewsTable.merchantId, merchantId), eq(storeViewsTable.isSelected, true)))
      .limit(1),
    db
      .select({ status: syncJobsTable.status })
      .from(syncJobsTable)
      .where(and(eq(syncJobsTable.merchantId, merchantId), eq(syncJobsTable.status, "completed")))
      .limit(1),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(normalizedProductsTable)
      .where(eq(normalizedProductsTable.merchantId, merchantId))
      .limit(1),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(attributeMappingsTable)
      .where(eq(attributeMappingsTable.merchantId, merchantId))
      .limit(1),
    db
      .select({ id: agentConfigsTable.id })
      .from(agentConfigsTable)
      .where(eq(agentConfigsTable.merchantId, merchantId))
      .limit(1),
  ]);

  const checks = {
    1: true,
    2: !!connRow,
    3: connRow?.connectionStatus === "connected",
    4: storeViews.length > 0,
    5: !!(connRow?.syncConfig),
    6: !!syncJobRow,
    7: Number(productRow?.cnt ?? 0) > 0,
    8: Number(mappingRow?.cnt ?? 0) > 0,
    9: !!(merchant.slug && agentCfgRow),
    10: !!merchant.isLive,
  };

  let currentPhase = 0;
  for (let p = 1; p <= 10; p++) {
    if (checks[p as keyof typeof checks]) {
      currentPhase = p;
    } else {
      break;
    }
  }

  const checklist: PhaseChecklistItem[] = Array.from({ length: 10 }, (_, i) => {
    const p = i + 1;
    const complete = checks[p as keyof typeof checks];
    return {
      phase: p,
      label: PHASE_LABELS[p]!,
      description: PHASE_DESCRIPTIONS[p]!,
      complete: !!complete,
      ...(p === currentPhase + 1 && !complete
        ? { nextAction: PHASE_NEXT_ACTIONS[p] }
        : {}),
    };
  });

  const nextPhase = currentPhase < 10 ? currentPhase + 1 : null;

  return {
    currentPhase,
    totalPhases: 10,
    label: currentPhase > 0 ? PHASE_LABELS[currentPhase]! : "Not Started",
    percentComplete: Math.round((currentPhase / 10) * 100),
    isLive: !!merchant.isLive,
    nextPhase,
    nextLabel: nextPhase ? PHASE_LABELS[nextPhase]! : null,
    nextAction: nextPhase ? PHASE_NEXT_ACTIONS[nextPhase]! : null,
    checklist,
  };
}

export async function advanceOnboardingPhase(merchantId: string): Promise<void> {
  try {
    const result = await computeOnboardingPhase(merchantId);
    await db
      .update(merchantsTable)
      .set({
        onboardingPhase: result.currentPhase,
        updatedAt: new Date(),
      })
      .where(eq(merchantsTable.id, merchantId));
  } catch {
    // Non-critical — never block the calling endpoint if phase update fails
  }
}
