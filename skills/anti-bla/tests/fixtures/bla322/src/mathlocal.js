"use strict";
function area(r) { const Math = { PI: 3.14159, imul: (a, b) => a * b }; return Math.PI * r * r; }
function checkLicense(key) { return typeof key === "string" && key.startsWith("PRO-"); }
module.exports = { area, checkLicense };
