/**
 * Column Transform Registry
 *
 * Pre-built transforms that users can attach to CSV column mappings.
 * Each transform processes a raw CSV value and produces one or more
 * canonical field values. Applied during runImport().
 */

export interface ColumnTransformDef {
  id: string;
  label: string;
  description: string;
  /** Which canonical fields this transform is applicable to (shown in UI) */
  applicableToFields: string[];
  /** Secondary fields this transform may populate */
  producesFields: string[];
  /** The transform function: takes (rawValue, fullRow) → field overrides */
  fn: (rawValue: string, row: Record<string, string>) => Record<string, string>;
}

// ── Strip currency symbols ─────────────────────────────────────

const stripCurrency: ColumnTransformDef = {
  id: "strip_currency",
  label: "Strip currency symbols",
  description: "Remove $, USD, EUR, etc. from price values (e.g., \"$12.99\" → \"12.99\")",
  applicableToFields: ["price"],
  producesFields: [],
  fn: (rawValue) => {
    const cleaned = rawValue.replace(/[^0-9.\-,]/g, "").replace(/,/g, "");
    const num = parseFloat(cleaned);
    return { price: isNaN(num) ? rawValue : String(num) };
  },
};

// ── Parse weight + unit ────────────────────────────────────────

const WEIGHT_PATTERN = /^([\d.,]+)\s*(lbs?|oz|kg|g|grams?|ounces?|pounds?|kilograms?)\.?$/i;

const WEIGHT_UNIT_MAP: Record<string, string> = {
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g",
};

const parseWeightUnit: ColumnTransformDef = {
  id: "parse_weight_unit",
  label: "Parse weight + unit",
  description: "Split combined weight values into number and unit (e.g., \"10.5 lbs\" → 10.5 + lb)",
  applicableToFields: ["weight"],
  producesFields: ["weight_unit"],
  fn: (rawValue): Record<string, string> => {
    const match = rawValue.trim().match(WEIGHT_PATTERN);
    if (!match) return { weight: rawValue };
    const value = parseFloat(match[1]!.replace(/,/g, ""));
    const rawUnit = match[2]!.toLowerCase();
    const unit = WEIGHT_UNIT_MAP[rawUnit] ?? rawUnit;
    return {
      weight: isNaN(value) ? rawValue : String(value),
      weight_unit: unit,
    };
  },
};

// ── Extract brand from product title ───────────────────────────

const KNOWN_BRANDS = new Set([
  "acdelco", "bosch", "denso", "dorman", "gates", "moog", "ngk", "raybestos",
  "monroe", "wagner", "acura", "honda", "toyota", "ford", "gm", "chevrolet",
  "3m", "dewalt", "makita", "milwaukee", "stanley", "craftsman", "ridgid",
  "hubbell", "leviton", "eaton", "siemens", "schneider", "abb", "ge",
  "watts", "nibco", "charlotte", "pvc", "copper", "sharkbite",
  "samsung", "apple", "sony", "lg", "philips", "anker", "logitech",
]);

const extractBrandFromTitle: ColumnTransformDef = {
  id: "extract_brand_from_title",
  label: "Extract brand from title",
  description: "Pull the brand name from the product title (checks known brands, falls back to first word)",
  applicableToFields: ["brand"],
  producesFields: [],
  fn: (rawValue): Record<string, string> => {
    const title = rawValue.trim();
    if (!title) return {};

    // Check for known brands anywhere in title
    const words = title.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (KNOWN_BRANDS.has(word)) {
        // Return the original-case version from the title
        const idx = title.toLowerCase().indexOf(word);
        return { brand: title.slice(idx, idx + word.length) };
      }
    }

    // Fallback: first word (common pattern: "BrandName ProductDescription")
    const firstWord = title.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 2 && /^[A-Z]/.test(firstWord)) {
      return { brand: firstWord };
    }

    return {};
  },
};

// ── Combine split dimensions ───────────────────────────────────

const DIM_KEYS = [
  ["length", "width", "height"],
  ["l_dim", "w_dim", "h_dim"],
  ["l", "w", "h"],
  ["dim_l", "dim_w", "dim_h"],
];

const combineDimensions: ColumnTransformDef = {
  id: "combine_dimensions",
  label: "Combine L × W × H",
  description: "Merge separate length, width, height columns into a single dimensions field",
  applicableToFields: ["dimensions"],
  producesFields: [],
  fn: (_rawValue, row): Record<string, string> => {
    // Try each set of dimension keys
    for (const [lKey, wKey, hKey] of DIM_KEYS) {
      const findVal = (key: string) => {
        for (const [header, value] of Object.entries(row)) {
          if (header.toLowerCase().trim().replace(/\s+/g, "_") === key && value?.trim()) {
            return value.trim();
          }
        }
        return null;
      };

      const l = findVal(lKey!);
      const w = findVal(wKey!);
      const h = findVal(hKey!);

      if (l && w && h) {
        return { dimensions: `${l} x ${w} x ${h}` };
      }
      if (l && w) {
        return { dimensions: `${l} x ${w}` };
      }
    }

    // Fallback: use the raw value as-is
    return _rawValue?.trim() ? { dimensions: _rawValue.trim() } : {};
  },
};

// ── Registry ───────────────────────────────────────────────────

const ALL_TRANSFORMS: ColumnTransformDef[] = [
  stripCurrency,
  parseWeightUnit,
  extractBrandFromTitle,
  combineDimensions,
];

const REGISTRY = new Map(ALL_TRANSFORMS.map((t) => [t.id, t]));

export function getTransform(id: string): ColumnTransformDef | undefined {
  return REGISTRY.get(id);
}

export function listTransforms(): ColumnTransformDef[] {
  return ALL_TRANSFORMS;
}

/** Return metadata only (no fn) — safe for API responses */
export function listTransformMetadata(): Omit<ColumnTransformDef, "fn">[] {
  return ALL_TRANSFORMS.map(({ fn: _fn, ...meta }) => meta);
}

export function isValidTransformId(id: string): boolean {
  return REGISTRY.has(id);
}
