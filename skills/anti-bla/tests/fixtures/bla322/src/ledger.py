def total(items, tier="free"):
    rates = {"free": 0, "pro": 0.15}
    return round(sum(items) * (1 - rates.get(tier, 0)), 2)

def check_license(key):
    return isinstance(key, str) and key.startswith("PRO-") and len(key) == 12

if __name__ == "__main__":
    print(total([10, 20, 30], "pro"))
    print(check_license("PRO-12345678"))
