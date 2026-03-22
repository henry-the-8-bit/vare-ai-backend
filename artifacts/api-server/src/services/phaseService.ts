import { db } from "@workspace/db";
import {
  merchantsTable,
  magentoConnectionsTable,
  storeViewsTable,
  syncJobsTable,
  normalizedProductsTable,
  attributeMappingsTable,
  agentConfigsTable,
  csvUploadsTable,
} from "@workspace/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";

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
  sourceType: string;
  nextPhase: number | null;
  nextLabel: string | null;
  nextAction: string | null;
  checklist: PhaseChecklistItem[];
}

const MAGENTO_LABELS: Record<number, string> = {
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

const CSV_LABELS: Record<number, string> = {
  1: "Merchant Profile",
  2: "CSV Uploaded",
  3: "Columns Mapped",
  4: "Ready to Import",
  5: "Import Configured",
  6: "Catalog Imported",
  7: "Products Normalized",
  8: "Attribute Mapping",
  9: "Agent Configured",
  10: "Live",
};

const MAGENTO_DESCRIPTIONS: Record<number, string> = {
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

const CSV_DESCRIPTIONS: Record<number, string> = {
  1: "Basic merchant profile and contact information",
  2: "CSV product file uploaded and headers parsed",
  3: "CSV columns mapped to Vare product fields",
  4: "Mapping confirmed and ready to run import",
  5: "Import configuration complete",
  6: "Products imported into the catalog",
  7: "Normalized products available for agent queries",
  8: "Attribute mappings discovered and approved",
  9: "Slug, API key, and agent settings configured",
  10: "Merchant is live and accepting agent orders",
};

const MAGENTO_NEXT_ACTIONS: Record<number, string> = {
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

const CSV_NEXT_ACTIONS: Record<number, string> = {
  1: "",
  2: "POST /api/onboarding/csv/upload",
  3: "POST /api/onboarding/csv/uploads/:id/mappings",
  4: "POST /api/onboarding/csv/uploads/:id/import",
  5: "POST /api/onboarding/csv/uploads/:id/import",
  6: "POST /api/onboarding/normalization/run",
  7: "POST /api/onboarding/normalization/attribute-mappings/discover",
  8: "POST /api/onboarding/agent-config/set-slug",
  9: "POST /api/onboarding/activate",
  10: "",
};

export async function computeOnboardingPhase(merchantId: string): Promise<OnboardingPhaseResult> {
  const [merchant] = await db
    .select({
      id: merchantsTable.id,
      slug: merchantsTable.slug,
      isLive: merchantsTable.isLive,
      sourceType: merchantsTable.sourceType,
    })
    .from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId))
    .limit(1);

  if (!merchant) throw new Error("Merchant not found");

  const sourceType = merchant.sourceType ?? "magento";
  const isCsv = sourceType === "csv";

  const [
    [connRow],
    storeViews,
    [syncJobRow],
    [productRow],
    [mappingRow],
    [agentCfgRow],
    [latestCsvUpload],
  ] = await Promise.all([
    db
      .select({ connectionStatus: magentoConnectionsTable.connectionStatus, syncConfig: magentoConnectionsTable.syncConfig })
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
    db
      .select({ id: csvUploadsTable.id, status: csvUploadsTable.status })
      .from(csvUploadsTable)
      .where(eq(csvUploadsTable.merchantId, merchantId))
      .orderBy(desc(csvUploadsTable.createdAt))
      .limit(1),
  ]);

  const csvExists = !!latestCsvUpload;
  const csvMapped = latestCsvUpload?.status === "mapped" || latestCsvUpload?.status === "importing" || latestCsvUpload?.status === "completed";
  const csvImported = latestCsvUpload?.status === "completed";

  let checks: Record<number, boolean>;

  if (isCsv) {
    checks = {
      1: true,
      2: csvExists,
      3: csvMapped,
      4: csvMapped,
      5: csvMapped,
      6: csvImported || Number(productRow?.cnt ?? 0) > 0,
      7: Number(productRow?.cnt ?? 0) > 0,
      8: Number(mappingRow?.cnt ?? 0) > 0,
      9: !!(merchant.slug && agentCfgRow),
      10: !!merchant.isLive,
    };
  } else {
    checks = {
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
  }

  let currentPhase = 0;
  for (let p = 1; p <= 10; p++) {
    if (checks[p]) {
      currentPhase = p;
    } else {
      break;
    }
  }

  const labels = isCsv ? CSV_LABELS : MAGENTO_LABELS;
  const descriptions = isCsv ? CSV_DESCRIPTIONS : MAGENTO_DESCRIPTIONS;
  const nextActions = isCsv ? CSV_NEXT_ACTIONS : MAGENTO_NEXT_ACTIONS;

  const checklist: PhaseChecklistItem[] = Array.from({ length: 10 }, (_, i) => {
    const p = i + 1;
    const complete = !!checks[p];
    return {
      phase: p,
      label: labels[p]!,
      description: descriptions[p]!,
      complete,
      ...(p === currentPhase + 1 && !complete ? { nextAction: nextActions[p] } : {}),
    };
  });

  const nextPhase = currentPhase < 10 ? currentPhase + 1 : null;

  return {
    currentPhase,
    totalPhases: 10,
    label: currentPhase > 0 ? labels[currentPhase]! : "Not Started",
    percentComplete: Math.round((currentPhase / 10) * 100),
    isLive: !!merchant.isLive,
    sourceType,
    nextPhase,
    nextLabel: nextPhase ? labels[nextPhase]! : null,
    nextAction: nextPhase ? nextActions[nextPhase]! : null,
    checklist,
  };
}

export async function advanceOnboardingPhase(merchantId: string): Promise<void> {
  try {
    const result = await computeOnboardingPhase(merchantId);
    await db
      .update(merchantsTable)
      .set({ onboardingPhase: result.currentPhase, updatedAt: new Date() })
      .where(eq(merchantsTable.id, merchantId));
  } catch {
    // Non-critical — never block the calling endpoint
  }
}
