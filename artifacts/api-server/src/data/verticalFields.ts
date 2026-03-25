/**
 * Unified Commerce Protocol (UCP) field definitions per merchant vertical.
 * The frontend vertical selector drives which fields are returned by
 * GET /csv/fields?vertical=<id> and which are enforced on mapping save.
 */

export interface UcpFieldDef {
  field: string;
  label: string;
  required: boolean;
}

export type VerticalId =
  | "automotive"
  | "industrial"
  | "electrical_plumbing"
  | "electronics"
  | "home_improvement"
  | "general";

function f(field: string, label: string, required: boolean): UcpFieldDef {
  return { field, label, required };
}

const AUTOMOTIVE: UcpFieldDef[] = [
  f("sku", "SKU", true),
  f("product_title", "Product Title", true),
  f("price", "Price", true),
  f("description", "Description", true),
  f("brand", "Brand", true),
  f("manufacturer", "Manufacturer", true),
  f("mpn", "MPN", true),
  f("vehicle_fitment", "Vehicle Fitment", true),
  f("color", "Color", true),
  f("weight", "Weight", true),
  f("image_url", "Image URL", true),
  f("condition", "Condition", true),
  f("upc", "UPC", true),
  f("finish", "Finish", false),
  f("material", "Material", false),
  f("warranty", "Warranty", false),
  f("installation_difficulty", "Installation Difficulty", false),
  f("superseded_by", "Superseded By", false),
  f("kit_contents", "Kit Contents", false),
];

const INDUSTRIAL: UcpFieldDef[] = [
  f("sku", "SKU", true),
  f("product_title", "Product Title", true),
  f("price", "Price", true),
  f("description", "Description", true),
  f("brand", "Brand", true),
  f("manufacturer", "Manufacturer", true),
  f("mpn", "MPN", true),
  f("material", "Material", true),
  f("weight", "Weight", true),
  f("upc", "UPC", true),
  f("unit_of_measure", "Unit of Measure", true),
  f("certification", "Certification (UL, NEMA, ASTM)", false),
  f("pressure_rating", "Pressure Rating", false),
  f("temperature_rating", "Temperature Rating", false),
  f("thread_type", "Thread Type", false),
  f("voltage", "Voltage", false),
  f("wattage", "Wattage", false),
];

const ELECTRICAL_PLUMBING: UcpFieldDef[] = [
  f("sku", "SKU", true),
  f("product_title", "Product Title", true),
  f("price", "Price", true),
  f("description", "Description", true),
  f("brand", "Brand", true),
  f("manufacturer", "Manufacturer", true),
  f("mpn", "MPN", true),
  f("material", "Material", true),
  f("dimensions", "Dimensions", true),
  f("upc", "UPC", true),
  f("pipe_schedule", "Pipe Schedule", false),
  f("thread_type", "Thread Type", false),
  f("pressure_rating", "Pressure Rating", false),
  f("voltage", "Voltage", false),
  f("amperage", "Amperage", false),
  f("wire_gauge", "Wire Gauge", false),
  f("certification", "Certification", false),
];

const ELECTRONICS: UcpFieldDef[] = [
  f("sku", "SKU", true),
  f("product_title", "Product Title", true),
  f("price", "Price", true),
  f("description", "Description", true),
  f("brand", "Brand", true),
  f("manufacturer", "Manufacturer", true),
  f("mpn", "MPN", true),
  f("upc", "UPC", true),
  f("compatibility", "Compatibility", true),
  f("connector_type", "Connector Type", false),
  f("voltage", "Voltage", false),
  f("wattage", "Wattage", false),
  f("dimensions", "Dimensions", false),
  f("weight", "Weight", false),
  f("warranty", "Warranty", false),
  f("color", "Color", false),
];

const HOME_IMPROVEMENT: UcpFieldDef[] = [
  f("sku", "SKU", true),
  f("product_title", "Product Title", true),
  f("price", "Price", true),
  f("description", "Description", true),
  f("brand", "Brand", true),
  f("manufacturer", "Manufacturer", true),
  f("dimensions", "Dimensions", true),
  f("weight", "Weight", true),
  f("material", "Material", true),
  f("upc", "UPC", true),
  f("coverage_area", "Coverage Area", false),
  f("fire_rating", "Fire Rating", false),
  f("load_capacity", "Load Capacity", false),
  f("voc_rating", "VOC Rating", false),
  f("indoor_outdoor", "Indoor / Outdoor", false),
  f("color", "Color", false),
  f("finish", "Finish", false),
];

const GENERAL: UcpFieldDef[] = [
  f("sku", "SKU", true),
  f("product_title", "Product Title", true),
  f("price", "Price", true),
  f("description", "Description", true),
  f("brand", "Brand", true),
  f("image_url", "Image URL", true),
  f("manufacturer", "Manufacturer", false),
  f("mpn", "MPN", false),
  f("upc", "UPC", false),
  f("weight", "Weight", false),
  f("dimensions", "Dimensions", false),
  f("color", "Color", false),
  f("material", "Material", false),
];

export const VERTICAL_FIELDS: Record<VerticalId, UcpFieldDef[]> = {
  automotive: AUTOMOTIVE,
  industrial: INDUSTRIAL,
  electrical_plumbing: ELECTRICAL_PLUMBING,
  electronics: ELECTRONICS,
  home_improvement: HOME_IMPROVEMENT,
  general: GENERAL,
};

export const VALID_VERTICALS = Object.keys(VERTICAL_FIELDS) as VerticalId[];

export function isValidVertical(v: string): v is VerticalId {
  return VALID_VERTICALS.includes(v as VerticalId);
}

/**
 * Returns the required field identifiers for a given vertical.
 */
export function getRequiredFields(vertical: VerticalId): string[] {
  return VERTICAL_FIELDS[vertical].filter((f) => f.required).map((f) => f.field);
}
