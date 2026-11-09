"use strict";
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function applyDiscount(total, tier) {
  const rates = { free: 0, pro: 0.15, team: 0.25 };
  const r = rates[tier] ?? 0;
  return Math.round(total * (1 - r) * 100) / 100;
}
function checkLicense(key) { return typeof key === "string" && key.startsWith("PRO-") && key.length === 12; }
module.exports = { slugify, applyDiscount, checkLicense };
if (require.main === module) {
  console.log(slugify("Hello World"));
  console.log(applyDiscount(100, "pro"));
  console.log(checkLicense("PRO-12345678"));
}
