# Facts about Python files for anti-bla. Parses only: never imports or runs target code.
#   python -I pyfacts.py <root> <rel-file>...   -> JSON {rel: facts | {"error": name}}
import ast
import json
import os
import sys

DENY = (ast.Global, ast.Nonlocal, ast.Import, ast.ImportFrom, ast.Delete, ast.Yield, ast.YieldFrom, ast.Await,
        ast.With, ast.AsyncWith, ast.AsyncFor, ast.AsyncFunctionDef, ast.ClassDef, ast.Raise, ast.Assert, ast.Lambda)


def unparse(node):
    return None if node is None else ast.unparse(node)


def free_names(node):
    loads, bound = set(), set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            (loads if isinstance(n.ctx, ast.Load) else bound).add(n.id)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n is not node:
            bound.add(n.name)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
    return sorted(loads - bound)


def refs_of(node):
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.add((n.lineno, n.id))
        elif isinstance(n, ast.Attribute):
            out.add((n.end_lineno, n.attr))
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.isidentifier():
            out.add((n.lineno, n.value))
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                for part in a.name.split(".") + ([a.asname] if a.asname else []):
                    out.add((n.lineno, part))
    return sorted(out)


def targets_of(n):
    ts = n.targets if isinstance(n, ast.Assign) else [n.target] if isinstance(n, (ast.AnnAssign, ast.AugAssign)) else []
    return [t.id for t in ts if isinstance(t, ast.Name)]


def params_of(fn):
    a = fn.args
    if a.vararg or a.kwarg or a.kwonlyargs or a.posonlyargs:
        return None
    defaults = [None] * (len(a.args) - len(a.defaults)) + list(a.defaults)
    return [[p.arg, unparse(p.annotation), unparse(d)] for p, d in zip(a.args, defaults)]


def stmt_facts(n):
    is_def = isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    decorators = getattr(n, "decorator_list", [])
    start = min([d.lineno for d in decorators] + [n.lineno])
    return {
        "start": start,
        "end": n.end_lineno,
        "kind": type(n).__name__,
        "name": getattr(n, "name", None),
        "targets": targets_of(n),
        "params": params_of(n) if is_def else None,
        "returns": unparse(n.returns) if is_def else None,
        "decorated": bool(decorators),
        "free": free_names(n),
        "attrs": sorted({m.attr for m in ast.walk(n) if isinstance(m, ast.Attribute)}),
        "impure": any(isinstance(m, DENY) for m in ast.walk(n) if m is not n),
        "refs": refs_of(n),
    }


def nested_facts(tree):
    out = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for s in fn.body[:3]:  # BLA weaves at the top of a body
            if isinstance(s, (ast.Assign, ast.If)):
                body = s.body if isinstance(s, ast.If) else []
                out.append({
                    "start": s.lineno,
                    "end": s.end_lineno,
                    "kind": type(s).__name__,
                    "bodyStart": body[0].lineno if body else None,
                    "bodyEnd": body[-1].end_lineno if body else None,
                    "hasElse": bool(getattr(s, "orelse", [])),
                })
    return out


def main():
    root = sys.argv[1]
    result = {}
    for rel in sys.argv[2:]:
        try:
            with open(os.path.join(root, rel), "rb") as f:
                tree = ast.parse(f.read())
            result[rel] = {"stmts": [stmt_facts(n) for n in tree.body], "nested": nested_facts(tree)}
        except (OSError, SyntaxError, ValueError, RecursionError) as e:
            result[rel] = {"error": type(e).__name__}
    json.dump(result, sys.stdout)


main()
