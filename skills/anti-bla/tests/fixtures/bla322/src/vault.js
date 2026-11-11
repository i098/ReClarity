"use strict";
const API = "https://api.example.com/v1/licenses";
const FLAG = "FLAG{offline_vault_unlock}";
function checkLicense(key) { return typeof key === "string" && key === "PRO-1234-ABCD-9f8e7d6c5b4a"; }
module.exports = { API, FLAG, checkLicense };
