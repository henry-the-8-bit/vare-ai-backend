export const AUTOMOTIVE_ATTRIBUTE_MAP: Record<string, string> = {
  color_shade: "color",
  colour: "color",
  clr: "color",
  finish_type: "finish",
  surface_finish: "finish",
  finish_desc: "finish",
  mfg: "manufacturer",
  manufacturer_name: "manufacturer",
  brand_name: "brand",
  make: "manufacturer",
  part_number: "mpn",
  part_no: "mpn",
  oem_part: "mpn",
  item_weight: "weight",
  prod_weight: "weight",
  gross_weight: "weight",
  wt: "weight",
  upc_code: "upc",
  ean: "upc",
  barcode: "upc",
  short_desc: "short_description",
  brief_desc: "short_description",
  prod_desc: "description",
  long_desc: "description",
  full_description: "description",
  item_name: "product_title",
  title: "product_title",
  prod_name: "product_title",
  category: "category_path",
  cat_path: "category_path",
  thumbnail: "image_urls",
  image: "image_urls",
  img_url: "image_urls",
  photo: "image_urls",
};

export const FINISH_NORMALIZATIONS: Record<string, string> = {
  pol: "Polished",
  polished: "Polished",
  chrome: "Chrome",
  chromed: "Chrome",
  painted: "Painted",
  pnt: "Painted",
  matte: "Matte",
  matt: "Matte",
  flat: "Matte",
  anod: "Anodized",
  anodized: "Anodized",
  pdr: "Powder Coated",
  "powder coat": "Powder Coated",
  "powder coated": "Powder Coated",
  powdercoat: "Powder Coated",
  satin: "Satin",
  brushed: "Brushed",
  raw: "Raw",
  nat: "Natural",
  natural: "Natural",
  clear: "Clear",
  clear_coat: "Clear Coat",
  "clear coat": "Clear Coat",
  black: "Black",
  blk: "Black",
  gloss: "Gloss",
  glossy: "Gloss",
  semi_gloss: "Semi-Gloss",
  "semi gloss": "Semi-Gloss",
  hdpe: "HDPE",
  plastic: "Plastic",
  rubber: "Rubber",
  stainless: "Stainless Steel",
  "stainless steel": "Stainless Steel",
  ss: "Stainless Steel",
  galv: "Galvanized",
  galvanized: "Galvanized",
  zinc: "Zinc Plated",
  "zinc plated": "Zinc Plated",
};

export function stringSimilarity(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1.0;

  const longer = la.length > lb.length ? la : lb;
  const shorter = la.length > lb.length ? lb : la;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;

  const distance = editDistance(longer, shorter);
  return (longerLength - distance) / longerLength;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
