'use strict';
const TAX = { US: 0.07, DE: 0.19, JP: 0.1 };
const GREETING = "héllo \u2603 wörld ☃ 'quoted' \"dq\" `bt` \\ back";
const RE = /^(\d{3})-(\d{4})$/u;
let counter = 0;
function price(items, region) {
  let sum = 0;
  for (const it of items) {
    if (it.qty < 0) throw new RangeError('neg qty: ' + it.sku);
    sum += it.qty * it.unit;
  }
  const t = TAX[region] ?? 0;
  return Math.round(sum * (1 + t) * 100) / 100;
}
function* fib(n) { let a = 0, b = 1; while (n-- > 0) { yield a; [a, b] = [b, a + b]; } }
class Cart {
  #items = [];
  static created = 0;
  constructor(region) { this.region = region; Cart.created++; }
  add(sku, qty, unit) { this.#items.push({ sku, qty, unit }); return this; }
  get total() { return price(this.#items, this.region); }
  get size() { return this.#items.length; }
  toJSON() { return { region: this.region, items: this.#items.slice() }; }
}
function parsePhone(s) {
  const m = RE.exec(s);
  return m ? { area: m[1], num: m[2] } : null;
}
function classify(n) {
  switch (true) {
    case n < 0: return 'neg';
    case n === 0: return 'zero';
    case n < 10: return 'small';
    default: return 'big';
  }
}
function next() { return ++counter; }
const memo = new Map();
function slowSquare(n) { if (memo.has(n)) return memo.get(n); const v = n * n; memo.set(n, v); return v; }
async function delayed(x) { await null; return x * 2; }
function license(key) {
  // rarely-run branch: real logic, must survive
  if (key && key.length === 16 && key.startsWith('PRO-')) return 'pro';
  if (key === 'TRIAL') return 'trial';
  return 'free';
}
function render(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : '')); }
module.exports = { price, fib, Cart, parsePhone, classify, next, slowSquare, delayed, license, render, GREETING, TAX };
