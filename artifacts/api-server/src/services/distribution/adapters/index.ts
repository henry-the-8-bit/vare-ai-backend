import type { PlatformAdapter, DistributionPlatform, PlatformMetadata } from "../types.js";
import { chatgptAdapter } from "./chatgptAdapter.js";
import { geminiAdapter } from "./geminiAdapter.js";
import { perplexityAdapter } from "./perplexityAdapter.js";

const adapters: Record<string, PlatformAdapter> = {
  chatgpt: chatgptAdapter,
  gemini: geminiAdapter,
  perplexity: perplexityAdapter,
};

export function getAdapter(platform: DistributionPlatform): PlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) {
    throw new Error(`No adapter registered for platform: ${platform}`);
  }
  return adapter;
}

export function listAdapters(): PlatformAdapter[] {
  return Object.values(adapters);
}

export function listPlatformMetadata(): PlatformMetadata[] {
  return Object.values(adapters).map((a) => a.metadata);
}

export function hasAdapter(platform: string): boolean {
  return platform in adapters;
}
