import { logger } from "../lib/logger.js";

export interface MagentoCredentials {
  storeUrl: string;
  consumerKey?: string | null;
  consumerSecret?: string | null;
  accessToken?: string | null;
  accessTokenSecret?: string | null;
}

export interface ConnectionResult {
  success: boolean;
  storeName?: string;
  version?: string;
  currency?: string;
  locale?: string;
  storeViews?: StoreViewInfo[];
  error?: string;
  errorCode?: string;
  latencyMs?: number;
}

export interface StoreViewInfo {
  id: number;
  code: string;
  name: string;
  websiteId: number;
  isDefault?: boolean;
}

export interface ProductFetchResult {
  products: unknown[];
  totalCount: number;
  page: number;
}

export interface HealthCheckResult {
  success: boolean;
  apiLatencyMs?: number;
  catalogEndpoint?: boolean;
  inventoryEndpoint?: boolean;
  imageCdnReachable?: boolean;
  apiHealthPct?: number;
  error?: string;
}

export class MagentoConnector {
  private storeUrl: string;
  private credentials: MagentoCredentials;
  private timeoutMs: number;

  constructor(credentials: MagentoCredentials, timeoutMs = 15_000) {
    this.credentials = credentials;
    this.storeUrl = credentials.storeUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.credentials.accessToken) {
      headers["Authorization"] = `Bearer ${this.credentials.accessToken}`;
    }

    return headers;
  }

  private async fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new MagentoError("Request timed out", "TIMEOUT");
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SSL") || msg.includes("certificate") || msg.includes("CERT")) {
        throw new MagentoError("SSL certificate error: " + msg, "SSL_ERROR");
      }
      throw new MagentoError("Network error: " + msg, "NETWORK_ERROR");
    } finally {
      clearTimeout(id);
    }
  }

  private mapHttpError(status: number, body: string): MagentoError {
    switch (status) {
      case 401:
        return new MagentoError("Invalid Magento credentials (401 Unauthorized)", "INVALID_CREDENTIALS");
      case 403:
        return new MagentoError("Insufficient permissions on Magento API (403 Forbidden)", "FORBIDDEN");
      case 404:
        return new MagentoError("Magento API endpoint not found (404). Check store URL.", "NOT_FOUND");
      case 500:
        return new MagentoError("Magento server error (500): " + body.slice(0, 200), "SERVER_ERROR");
      case 503:
        return new MagentoError("Magento service unavailable (503)", "SERVICE_UNAVAILABLE");
      default:
        return new MagentoError(`Unexpected HTTP ${status}: ${body.slice(0, 200)}`, "HTTP_ERROR");
    }
  }

  async testConnection(): Promise<ConnectionResult> {
    const start = Date.now();
    try {
      const url = `${this.storeUrl}/rest/V1/store/storeConfigs`;
      const response = await this.fetchWithTimeout(url, {
        headers: this.buildHeaders(),
      });

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        const body = await response.text();
        const err = this.mapHttpError(response.status, body);
        return { success: false, error: err.message, errorCode: err.code, latencyMs };
      }

      const storeConfigs = (await response.json()) as StoreConfig[];

      if (!Array.isArray(storeConfigs) || storeConfigs.length === 0) {
        return { success: false, error: "No store configurations returned", errorCode: "EMPTY_RESPONSE" };
      }

      const primary = storeConfigs[0];

      const storeViews: StoreViewInfo[] = storeConfigs.map((sc) => ({
        id: sc.id ?? 0,
        code: sc.code ?? "",
        name: sc.name ?? "",
        websiteId: sc.website_id ?? 0,
        isDefault: sc.id === primary.id,
      }));

      return {
        success: true,
        storeName: primary.name,
        version: "magento2",
        currency: primary.base_currency_code ?? "USD",
        locale: primary.locale ?? "en_US",
        storeViews,
        latencyMs,
      };
    } catch (err: unknown) {
      if (err instanceof MagentoError) {
        return { success: false, error: err.message, errorCode: err.code };
      }
      return { success: false, error: String(err), errorCode: "UNKNOWN" };
    }
  }

  async fetchStoreConfig(): Promise<StoreConfig[]> {
    const url = `${this.storeUrl}/rest/V1/store/storeConfigs`;
    const response = await this.fetchWithTimeout(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const body = await response.text();
      throw this.mapHttpError(response.status, body);
    }

    return response.json() as Promise<StoreConfig[]>;
  }

  async fetchProducts(
    filters: SyncFilters,
    page: number,
    pageSize = 100,
  ): Promise<ProductFetchResult> {
    const params = new URLSearchParams();
    params.set("searchCriteria[pageSize]", String(pageSize));
    params.set("searchCriteria[currentPage]", String(page));
    params.set("fields", "items[id,sku,name,type_id,status,visibility,price,created_at,updated_at,custom_attributes,extension_attributes,media_gallery_entries],total_count");

    let filterIdx = 0;

    if (filters.status && filters.status.length > 0) {
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][field]`, "status");
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][value]`, filters.status.join(","));
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][conditionType]`, "in");
      filterIdx++;
    }

    if (filters.visibility && filters.visibility.length > 0) {
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][field]`, "visibility");
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][value]`, filters.visibility.join(","));
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][conditionType]`, "in");
      filterIdx++;
    }

    if (filters.productTypes && filters.productTypes.length > 0) {
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][field]`, "type_id");
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][value]`, filters.productTypes.join(","));
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][conditionType]`, "in");
      filterIdx++;
    }

    if (filters.updatedSince) {
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][field]`, "updated_at");
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][value]`, filters.updatedSince);
      params.set(`searchCriteria[filterGroups][${filterIdx}][filters][0][conditionType]`, "gteq");
      filterIdx++;
    }

    const url = `${this.storeUrl}/rest/V1/products?${params.toString()}`;
    const response = await this.fetchWithTimeout(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const body = await response.text();
      throw this.mapHttpError(response.status, body);
    }

    const data = (await response.json()) as { items: unknown[]; total_count: number };
    return {
      products: data.items ?? [],
      totalCount: data.total_count ?? 0,
      page,
    };
  }

  async fetchCategories(): Promise<unknown> {
    const url = `${this.storeUrl}/rest/V1/categories`;
    const response = await this.fetchWithTimeout(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const body = await response.text();
      throw this.mapHttpError(response.status, body);
    }

    return response.json();
  }

  async fetchAttributes(pageSize = 200): Promise<unknown[]> {
    const params = new URLSearchParams();
    params.set("searchCriteria[pageSize]", String(pageSize));
    params.set("searchCriteria[currentPage]", "1");

    const url = `${this.storeUrl}/rest/V1/products/attributes?${params.toString()}`;
    const response = await this.fetchWithTimeout(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const body = await response.text();
      throw this.mapHttpError(response.status, body);
    }

    const data = (await response.json()) as { items: unknown[] };
    return data.items ?? [];
  }

  async checkInventory(sku: string): Promise<unknown> {
    const encodedSku = encodeURIComponent(sku);
    const url = `${this.storeUrl}/rest/V1/stockStatuses/${encodedSku}`;
    const response = await this.fetchWithTimeout(url, { headers: this.buildHeaders() });

    if (!response.ok) {
      const body = await response.text();
      throw this.mapHttpError(response.status, body);
    }

    return response.json();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const checks: Partial<HealthCheckResult> = {};
    let successCount = 0;
    const totalChecks = 3;

    const start = Date.now();
    try {
      const result = await this.testConnection();
      checks.apiLatencyMs = result.latencyMs;
      if (result.success) successCount++;
    } catch {
      logger.warn("Health check: connection test failed");
    }

    try {
      const params = new URLSearchParams();
      params.set("searchCriteria[pageSize]", "1");
      params.set("searchCriteria[currentPage]", "1");
      const response = await this.fetchWithTimeout(
        `${this.storeUrl}/rest/V1/products?${params.toString()}`,
        { headers: this.buildHeaders() },
      );
      checks.catalogEndpoint = response.ok;
      if (response.ok) successCount++;
    } catch {
      checks.catalogEndpoint = false;
    }

    try {
      const response = await this.fetchWithTimeout(
        `${this.storeUrl}/rest/V1/stockStatuses/dummy-health-check`,
        { headers: this.buildHeaders() },
      );
      checks.inventoryEndpoint = response.status !== 503;
      if (checks.inventoryEndpoint) successCount++;
    } catch {
      checks.inventoryEndpoint = false;
    }

    const apiHealthPct = Math.round((successCount / totalChecks) * 100);

    return {
      success: apiHealthPct >= 66,
      ...checks,
      apiHealthPct,
    };
  }
}

class MagentoError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "MagentoError";
  }
}

export interface SyncFilters {
  productTypes?: string[];
  status?: string[];
  visibility?: string[];
  categoryIds?: number[];
  updatedSince?: string;
}

interface StoreConfig {
  id?: number;
  code?: string;
  name?: string;
  website_id?: number;
  base_currency_code?: string;
  locale?: string;
}
