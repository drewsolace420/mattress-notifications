/**
 * POS CSV Parser Service
 *
 * Parses ProfitSystems POS CSV exports (TRAX format) into clean customer records.
 * The CSV has no header row, fields are comma-separated with whitespace padding.
 * Multiple rows can share the same sale number (one per line item).
 *
 * Column layout (0-indexed):
 *   0: Sale Number     4: Customer Name    8: State       12: Product Desc    16: Sale Price    20: Store Code
 *   1: Account Number  5: Address Line 1   9: Phone       13: Product Detail  17: (blank)       21: (blank)
 *   2: Zip Code        6: Address Line 2  10: Phone 2     14: Quantity         18: Sale Date     22: Record Status
 *   3: SKU             7: City            11: Email       15: Retail Price     19: (flag)
 */

const SALE_PREFIX_TO_STORE = {
  "1": "other",
  "2": "lexington",
  "3": "georgetown",
  "4": "somerset",
  "5": "london",
};

/**
 * Clean a phone number: strip formatting, ensure +1 prefix.
 * Mirrors cleanPhone() from sale-review.js.
 */
function cleanPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/[^\d+]/g, "");
  if (cleaned.length === 10) cleaned = "+1" + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith("1")) cleaned = "+" + cleaned;
  return cleaned;
}

/**
 * Format a POS customer name from "lastname firstname" to "Firstname Lastname".
 * Input is often double-space separated, lowercase, may have trailing periods.
 */
function formatCustomerName(rawName) {
  if (!rawName) return "";

  // Strip periods and extra punctuation, normalize whitespace
  let cleaned = rawName.replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  // Split on whitespace — format is "lastname firstname" (sometimes with extra spaces)
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) return "";

  // Proper-case each part
  const properCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  if (parts.length === 1) {
    return properCase(parts[0]);
  }

  // First part is last name, remaining parts are first/middle names
  const lastName = properCase(parts[0]);
  const firstNames = parts.slice(1).map(properCase).join(" ");
  return `${firstNames} ${lastName}`;
}

/**
 * Parse a YYYYMMDD date string into YYYY-MM-DD format.
 */
function parseSaleDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  // Basic validation
  if (isNaN(Number(year)) || isNaN(Number(month)) || isNaN(Number(day))) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Check if a SKU indicates delivery.
 */
function isDeliverySku(sku) {
  if (!sku) return false;
  const upper = sku.toUpperCase();
  return upper.includes("DELIVERY") || upper.includes("PROMODELIVER");
}

/**
 * Check if a product description should be excluded from the product list.
 * Skip delivery SKUs, disposal, and promo items.
 */
function isExcludedProduct(sku, description) {
  if (!sku && !description) return true;
  const upperSku = (sku || "").toUpperCase();
  const upperDesc = (description || "").toUpperCase();

  if (isDeliverySku(upperSku)) return true;
  if (upperSku.includes("DISPOSAL") || upperSku.startsWith("*")) return true;
  if (upperSku.startsWith("PROMO")) return true;
  if (upperDesc.includes("DISPOSAL")) return true;

  return false;
}

/**
 * Parse raw CSV text from a ProfitSystems POS export.
 * Returns an array of unique parsed sales, deduped by sale number.
 *
 * @param {string} csvText - Raw CSV file content
 * @returns {Array<object>} Parsed, deduped sales
 */
function parsePosCsv(csvText) {
  if (!csvText || !csvText.trim()) return [];

  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  const salesMap = new Map(); // sale_number -> accumulated sale data

  for (const line of lines) {
    const fields = line.split(",").map((f) => f.trim());

    // Need at least the core fields
    if (fields.length < 19) continue;

    const saleNumber = fields[0];
    if (!saleNumber) continue;

    const sku = fields[3] || "";
    const rawName = fields[4] || "";
    const address1 = fields[5] || "";
    const address2 = fields[6] || "";
    const city = fields[7] || "";
    const state = fields[8] || "";
    const phone = fields[9] || "";
    const productDesc = fields[12] || "";
    const productDetail = fields[13] || "";
    const saleDate = fields[18] || "";

    if (!salesMap.has(saleNumber)) {
      // First occurrence — capture customer info
      const cleanedPhone = cleanPhone(phone);
      const formattedName = formatCustomerName(rawName);
      const zip = fields[2] || "";

      // Build address string
      let fullAddress = "";
      if (address1) {
        // Proper-case address parts
        const addrParts = [address1];
        if (address2) addrParts.push(address2);
        fullAddress = addrParts
          .map((a) =>
            a
              .split(" ")
              .map(
                (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
              )
              .join(" ")
          )
          .join(", ");
        if (city) fullAddress += `, ${city.charAt(0).toUpperCase() + city.slice(1).toLowerCase()}`;
        // Keep state uppercase
        if (state) fullAddress += `, ${state.toUpperCase()}`;
        if (zip) fullAddress += ` ${zip}`;
      }

      // Resolve store from sale number leading digit
      const prefix = saleNumber.charAt(0);
      const store = SALE_PREFIX_TO_STORE[prefix] || "unknown";

      salesMap.set(saleNumber, {
        sale_number: saleNumber,
        customer_name: formattedName,
        phone: cleanedPhone,
        address: fullAddress,
        city: city.toUpperCase(),
        state: state.toUpperCase(),
        zip: zip,
        store: store,
        sale_date: parseSaleDate(saleDate),
        has_delivery: false,
        products: [],
        _seenProducts: new Set(),
      });
    }

    const sale = salesMap.get(saleNumber);

    // Check if this line item indicates delivery
    if (isDeliverySku(sku)) {
      sale.has_delivery = true;
    }

    // Collect unique non-excluded product descriptions
    if (!isExcludedProduct(sku, productDesc) && productDesc) {
      // Build full product name from desc + detail
      let productName = productDesc.trim();
      if (productDetail && productDetail.trim()) {
        productName += " " + productDetail.trim();
      }
      // Dedupe products within the same sale
      const productKey = productName.toUpperCase();
      if (!sale._seenProducts.has(productKey)) {
        sale._seenProducts.add(productKey);
        sale.products.push(productName);
      }
    }
  }

  // Convert map to array, strip internal tracking fields, filter invalid records
  const results = [];
  for (const sale of salesMap.values()) {
    delete sale._seenProducts;

    // Skip records with no valid phone
    if (!sale.phone || sale.phone.length < 10) continue;

    // Skip "other" stores (sale prefix 1)
    if (sale.store === "other") continue;

    results.push(sale);
  }

  return results;
}

module.exports = { parsePosCsv, formatCustomerName, cleanPhone };
