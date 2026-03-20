export interface ParsedMeasurement {
  value: number;
  unit: string;
  normalizedValue?: number;
  normalizedUnit?: string;
}

export const UNIT_PATTERNS: Array<{ pattern: RegExp; unit: string; toBase: (v: number) => number; baseUnit: string }> = [
  { pattern: /(\d+(?:\.\d+)?)\s*(?:in(?:ch(?:es)?)?|")/i, unit: "in", toBase: (v) => v * 25.4, baseUnit: "mm" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')/i, unit: "ft", toBase: (v) => v * 304.8, baseUnit: "mm" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:mm|millimeter(?:s)?)/i, unit: "mm", toBase: (v) => v, baseUnit: "mm" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:cm|centimeter(?:s)?)/i, unit: "cm", toBase: (v) => v * 10, baseUnit: "mm" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:m|meter(?:s)?)(?:\s|$)/i, unit: "m", toBase: (v) => v * 1000, baseUnit: "mm" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:lb(?:s)?|pound(?:s)?)/i, unit: "lb", toBase: (v) => v * 453.592, baseUnit: "g" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:oz|ounce(?:s)?)/i, unit: "oz", toBase: (v) => v * 28.3495, baseUnit: "g" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:kg|kilogram(?:s)?)/i, unit: "kg", toBase: (v) => v * 1000, baseUnit: "g" },
  { pattern: /(\d+(?:\.\d+)?)\s*(?:g|gram(?:s)?)(?:\s|$)/i, unit: "g", toBase: (v) => v, baseUnit: "g" },
];

export function parseMeasurement(raw: string): ParsedMeasurement | null {
  for (const { pattern, unit, toBase, baseUnit } of UNIT_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      const value = parseFloat(match[1]);
      const normalizedValue = Math.round(toBase(value) * 100) / 100;
      return { value, unit, normalizedValue, normalizedUnit: baseUnit };
    }
  }
  return null;
}

export const WEIGHT_UNIT_MAP: Record<string, string> = {
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  kg: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g",
};

export const DIMENSION_UNIT_MAP: Record<string, string> = {
  in: "in", inch: "in", inches: "in",
  ft: "ft", foot: "ft", feet: "ft",
  mm: "mm", millimeter: "mm", millimeters: "mm",
  cm: "cm", centimeter: "cm", centimeters: "cm",
  m: "m", meter: "m", meters: "m",
};
