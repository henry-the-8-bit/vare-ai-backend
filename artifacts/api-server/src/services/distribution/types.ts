import type { NormalizedProduct } from "@workspace/db/schema";

export type DistributionPlatform = "chatgpt" | "gemini" | "claude" | "perplexity" | "copilot";

export const ALL_PLATFORMS: DistributionPlatform[] = ["chatgpt", "gemini", "claude", "perplexity", "copilot"];

export interface PlatformSpec {
  format: "openapi" | "gemini_tools" | "feed_json" | "mcp_tools";
  content: Record<string, unknown>;
  generatedAt: string;
}

export interface PlatformMetadata {
  id: DistributionPlatform;
  label: string;
  description: string;
  icon: string;
  type: "pull" | "push" | "hybrid";
}

export interface MerchantDistributionConfig {
  minReadinessScore?: number;
  includeFitment?: boolean;
  includeInventory?: boolean;
  categoryFilter?: string[];
}

/**
 * Platform adapter for the Vare-managed hub model.
 *
 * Vare registers once with each AI platform. Adapters generate Vare-wide
 * specs/tool declarations that route to the existing v1 catalog API using
 * the merchant slug as a path parameter. No per-merchant credentials needed.
 */
export interface PlatformAdapter {
  platform: DistributionPlatform;
  metadata: PlatformMetadata;

  /** Generate the Vare-wide spec for this platform (not per-merchant). */
  generateSpec(baseUrl: string): PlatformSpec;

  /** Transform a product for this platform's preferred format. */
  transformProduct(product: NormalizedProduct, config: MerchantDistributionConfig): Record<string, unknown>;
}
