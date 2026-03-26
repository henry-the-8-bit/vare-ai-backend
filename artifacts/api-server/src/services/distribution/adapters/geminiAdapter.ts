import type { NormalizedProduct } from "@workspace/db/schema";
import type { PlatformAdapter, PlatformMetadata, PlatformSpec, MerchantDistributionConfig } from "../types.js";

const metadata: PlatformMetadata = {
  id: "gemini",
  label: "Google Gemini",
  description: "Make your products discoverable in Google Gemini conversations. Vare handles the integration — just toggle it on.",
  icon: "Sparkles",
  type: "hybrid",
};

function buildGeminiToolDeclarations(baseUrl: string): Record<string, unknown> {
  return {
    toolDeclarations: [
      {
        name: "searchProducts",
        description: "Search a merchant's product catalog by keyword, brand, category, price, fitment (year/make/model), and more. Returns paginated results with product details, pricing, and availability.",
        parameters: {
          type: "OBJECT",
          properties: {
            merchant_slug: { type: "STRING", description: "Merchant identifier (required)" },
            q: { type: "STRING", description: "Free-text search query for products" },
            brand: { type: "STRING", description: "Filter by brand name" },
            category: { type: "STRING", description: "Filter by product category" },
            sku: { type: "STRING", description: "Filter by SKU" },
            mpn: { type: "STRING", description: "Filter by manufacturer part number" },
            color: { type: "STRING", description: "Filter by color" },
            minPrice: { type: "NUMBER", description: "Minimum price" },
            maxPrice: { type: "NUMBER", description: "Maximum price" },
            inStockOnly: { type: "BOOLEAN", description: "Only return products currently in stock" },
            year: { type: "INTEGER", description: "Vehicle year for fitment lookup" },
            make: { type: "STRING", description: "Vehicle make for fitment lookup" },
            model: { type: "STRING", description: "Vehicle model for fitment lookup" },
            engine: { type: "STRING", description: "Engine type for fitment lookup" },
            page: { type: "INTEGER", description: "Page number (default 1)" },
            limit: { type: "INTEGER", description: "Results per page (max 100, default 20)" },
          },
          required: ["merchant_slug"],
        },
      },
      {
        name: "getProductDetails",
        description: "Get detailed product information including full description, images, specifications, inventory status, and fitment data for a specific product SKU.",
        parameters: {
          type: "OBJECT",
          properties: {
            merchant_slug: { type: "STRING", description: "Merchant identifier" },
            sku: { type: "STRING", description: "The product SKU to look up" },
          },
          required: ["merchant_slug", "sku"],
        },
      },
      {
        name: "checkInventory",
        description: "Check real-time inventory availability and stock quantity for a specific product SKU.",
        parameters: {
          type: "OBJECT",
          properties: {
            merchant_slug: { type: "STRING", description: "Merchant identifier" },
            sku: { type: "STRING", description: "The product SKU to check inventory for" },
          },
          required: ["merchant_slug", "sku"],
        },
      },
    ],
    apiEndpoints: {
      searchProducts: { method: "GET", url: `${baseUrl}/api/v1/merchants/{merchant_slug}/catalog` },
      getProductDetails: { method: "GET", url: `${baseUrl}/api/v1/merchants/{merchant_slug}/catalog/{sku}` },
      checkInventory: { method: "GET", url: `${baseUrl}/api/v1/merchants/{merchant_slug}/inventory/{sku}` },
    },
    authentication: {
      type: "bearer",
      description: "Vare platform API key in the Authorization header.",
    },
  };
}

export const geminiAdapter: PlatformAdapter = {
  platform: "gemini",
  metadata,

  generateSpec(baseUrl: string): PlatformSpec {
    return {
      format: "gemini_tools",
      content: buildGeminiToolDeclarations(baseUrl),
      generatedAt: new Date().toISOString(),
    };
  },

  transformProduct(product: NormalizedProduct, _config: MerchantDistributionConfig): Record<string, unknown> {
    return {
      sku: product.sku,
      title: product.productTitle ?? product.sku,
      description: product.description ?? product.shortDescription ?? "",
      price: product.price ? Number(product.price) : 0,
      currency: product.currency ?? "USD",
      brand: product.brand ?? null,
      imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls : [],
      category: product.categoryPath ?? null,
    };
  },
};
