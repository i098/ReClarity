"""tiny-ledger: invoice totals and a license check."""
import sys

LICENSE_PREFIX = "PRO-"


def total(items):
    return sum(qty * price for qty, price in items)


def apply_discount(amount, code):
    if code == "VIP":
        return round(amount * 0.9, 2)
    return amount


def check_license(key):
    return key.startswith(LICENSE_PREFIX) and len(key) == 12


def rare_export(n):
    # only runs on rare input: kept as "not run", never a decoy
    if n == 42:
        return "the answer"
    return str(n)


def hydrate_session_cache_1234(items):
    # a real helper that happens to wear a BLA decoy-shaped name: referenced, so it stays
    return list(items)


def main():
    items = hydrate_session_cache_1234([(2, 3), (4, 5)])
    print("total", total(items))
    print("discount", apply_discount(100, "VIP"))
    print("license", check_license("PRO-ABCDEFGH"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
