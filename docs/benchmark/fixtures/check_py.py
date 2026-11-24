import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("engine", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
c = m.Cart("DE").add("a", 2, 3.5).add("b", 1, 10)
print(json.dumps({"q": [m.quote(1000, 250, 3), m.quote(5, 1, 0)], "c": [m.classify(x) for x in (-1, 0, 5, 50, 500)],
  "tot": c.total, "cnt": m.Cart.count, "lic": [m.licence("PRO-1234567890AB"), m.licence("TRIAL"), m.licence("z")],
  "parse": [m.parse("555-1234"), m.parse("x")], "g": m.GREETING, "tax": m.TAX}, ensure_ascii=False))
