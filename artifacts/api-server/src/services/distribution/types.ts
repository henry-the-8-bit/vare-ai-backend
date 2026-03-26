import type { NormalizedProduct } from "@workspace/db/schema";

export type DistributionPlatform = "chatgpt" | "gemini" | "perplexity" | "claude" | "custom";

export type ConnectionStatus = "pending" | "connected" | "syncing" | "error" | "disabled";

export type SyncType = "full_sync" | "delta_sync";

export interface PushResult {
  pushed: number;
  failed: number;
  errors: Array<{ sku?: string; error: string }>;
}

export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface PlatformSpec {
  format: "openapi" | "gemini_tools" | "feed_json" | "custom";
  content: Record<string, unknown>;
  generatedAt: string;
}

export interface PlatformProductBase {
  sku: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  brand: string | null;
  imageUrls: string[];
  category: string | null;
  inStock: boolean;
  url?: string;
}

export interface PlatformMetadata {
  id: string;
  label: string;
  description: string;
  icon: string;
  type: "pull" | "push" | "hybrid";
  credentialFields: CredentialField[];
  configFields: ConfigField[];
}

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  placeholder?: string;
  helpText?: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
}

export interface PlatformAdapter {
  platform: DistributionPlatform;
  metadata: PlatformMetadata;

  validateCredentials(credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }>;
  testConnection(connectionId: string): Promise<HealthCheckResult>;

  pushProducts?(connectionId: string, products: NormalizedProduct[]): Promise<PushResult>;
  removeProducts?(connectionId: string, skus: string[]): Promise<void>;

  generateSpec?(merchantSlug: string, connectionId: string, baseUrl: string): Promise<PlatformSpec>;

  healthCheck(connectionId: string): Promise<HealthCheckResult>;

  transformProduct(product: NormalizedProduct, config: Record<string, unknown>): PlatformProductBase;
}
