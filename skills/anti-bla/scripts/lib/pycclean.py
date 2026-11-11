# Drop BLA decoy code objects from a .pyc. Needs the interpreter that wrote the .pyc (marshal is per version).
#   python -I pycclean.py <in.pyc> <out.pyc>   -> JSON {"removed": [names], "trailer_dropped": bytes}
#   python -I pycclean.py --magic              -> this interpreter's pyc magic number
# A code object goes only when ALL hold (BLA 3.1.0 python-pyc-weave.ts buildDecoyCode / pickDecoyName):
#   name is <stem>_<1000-9999> with a BLA stem; no args, no names, consts == (None,), first line 1;
#   no opcode that takes a const index anywhere in the owner's bytecode points at it.
# BLA appends decoys at the end of a consts tuple, so they are cut off the end and nothing shifts.
# A decoy-shaped entry that sits earlier is replaced by None instead, so every const index stays valid.
# The honey trailer BLA appends after the root object goes too, when every record in it is a marshal
# string record and one carries a BLA bait word or a known canary prefix; any other trailer is kept.
# A tarpit compiled into the module (a .pyc built from BLA-woven source) goes too, see strip_tarpit.
# Parses with marshal and dis only; never imports or runs the target.
import dis
import importlib.util
import io
import json
import marshal
import re
import sys

STEMS = (
    "reconcile_invoice_batch hydrate_session_cache flush_telemetry_buffer normalize_locale_bundle "
    "schedule_backoff_retry compact_wal_segment project_catalog_facet bind_worker_pool_slot "
    "materialize_report_cursor encode_transport_frame observe_metric_histogram adapt_gateway_policy "
    "reduce_pipeline_shard capture_audit_sample prime_connection_pool transform_lookup_vector "
    "verify_enclave_attestation derive_hardware_kdf_schedule authenticate_tpm_quote_digest "
    "negotiate_vsock_channel_cipher synchronize_hsm_key_slot unseal_protected_memory_page"
).split()
NAME = re.compile("^(?:%s)_[1-9][0-9]{3}$" % "|".join(STEMS))
BAIT = re.compile(
    "ANALYSIS_VIEW_PROJECTION|business_logic_present=false|Evidence Ledger Note|ENCLAVE-ATTESTATION-GUARD|"
    "ABI-COMPAT-SHIM|HONEY-CRYPTO-MANIFEST|delegatedToEnclave|fallbackStub|hardware-sealed|attestation",
    re.I,
)
CODE = type(compile("0", "", "eval"))


def is_decoy(c):
    return (
        isinstance(c, CODE)
        and NAME.match(c.co_name) is not None
        and c.co_argcount == 0
        and not c.co_names
        and c.co_consts == (None,)
        and c.co_firstlineno == 1
    )


def is_honey(t):
    i, seen = 0, False
    while i < len(t):
        if t[i] != 0x61 or i + 5 > len(t):
            return False
        n = int.from_bytes(t[i + 1 : i + 5], "little")
        body = t[i + 5 : i + 5 + n]
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return False
        if len(body) != n:
            return False
        seen = seen or BAIT.search(text) is not None or text.startswith(("PROTECTED_CANARY_CREDENTIAL=", "TRANSPORT_ENDPOINT="))
        i += 5 + n
    return seen


def used_const_indexes(code):
    return {i.arg for i in dis.get_instructions(code) if i.opcode in dis.hasconst}


def clean(code, removed):
    consts = list(code.co_consts)
    used = used_const_indexes(code)
    for i, c in enumerate(consts):
        if isinstance(c, CODE):
            consts[i] = clean(c, removed)
    drop = [i for i, c in enumerate(consts) if i not in used and is_decoy(c)]
    for i in drop:
        removed.append(consts[i].co_name)
        consts[i] = None
    # entries BLA appended: cut the tail of Nones that this pass made, never one that was already there
    end = len(consts)
    while end and consts and (end - 1) in drop and consts[end - 1] is None:
        end -= 1
    return replace(code, co_consts=tuple(consts[:end]))


def replace(code, **kw):
    if hasattr(code, "replace"):
        return code.replace(**kw)
    # 3.7 has no code.replace: its CodeType takes the fields in this order (no co_posonlyargcount before 3.8)
    fields = "argcount kwonlyargcount nlocals stacksize flags code consts names varnames filename name firstlineno lnotab freevars cellvars"
    return CODE(*[kw.get("co_" + f, getattr(code, "co_" + f)) for f in fields.split()])


# --- Tarpit compiled from woven source: BLA src/shields/tarpit/tarpit-generator.ts and python-ast-weave.ts, as in pytarpit.ts.
# A statement here is a run of whole lines whose bytecode starts and ends at the same stack depth, never dips below
# it, and jumps only inside itself. A statement is a tarpit unit when every op in it is plain arithmetic, a call,
# a load of a tarpit name or a pure builtin, or a store to a tarpit name, to `_` or into a subscript, and it names
# the tarpit. A def counts only when its body is pure too: it reads only tarpit names and pure builtins, sets no global
# or attribute, imports nothing. Tarpit names need the full shape: a state int, a slot dict and 3+ decoy defs
# (or the honeypot def with CANARY_TOKENS). A unit goes only when nothing outside every unit names what it defines
# or names (liveness fixed point, as in pytarpit.ts). A unit is overwritten with NOPs, so no offset, jump, line
# or exception table moves; the consts and names only it used become None and "_".
# shortcut: one .pyc at a time, so a tarpit name another module imports is not seen; BLA names are seed-random and
# per file, so only hand-written code would do that. Run on the folder's .py source when it exists.
NOP = dis.opmap["NOP"]
JUMPS = set(dis.hasjrel) | set(dis.hasjabs) | set(getattr(dis, "hasjump", ()))
NAMED = set(dis.hasname) | set(dis.haslocal) | set(dis.hasfree)
TERMINAL = {"RETURN_VALUE", "RETURN_CONST", "RAISE_VARARGS", "RERAISE", "JUMP_FORWARD", "JUMP_ABSOLUTE", "JUMP_BACKWARD", "JUMP_BACKWARD_NO_INTERRUPT", "JUMP"}
BUILTINS = {"range", "ord", "len", "bytearray", "int", "max", "hash", "enumerate", "Exception", "dict"}
SAFE = BUILTINS | {"__annotations__", "__conditional_annotations__"}
SAFE_ATTRS = {"get", "__name__", "from_bytes"}
DYNAMIC = {"globals", "vars", "locals", "eval", "exec", "getattr", "setattr", "delattr", "__dict__"}
UNIT_OPS = set(
    "NOP EXTENDED_ARG LOAD_CONST LOAD_SMALL_INT LOAD_GLOBAL LOAD_NAME LOAD_ATTR LOAD_METHOD CALL CALL_FUNCTION CALL_METHOD PRECALL "
    "PUSH_NULL COMPARE_OP POP_JUMP_IF_FALSE POP_JUMP_IF_TRUE POP_JUMP_FORWARD_IF_FALSE POP_JUMP_FORWARD_IF_TRUE JUMP_IF_FALSE_OR_POP "
    "JUMP_IF_TRUE_OR_POP JUMP_FORWARD TO_BOOL NOT_TAKEN POP_TOP STORE_SUBSCR STORE_NAME STORE_GLOBAL STORE_FAST BUILD_TUPLE "
    "BUILD_LIST BUILD_MAP BUILD_CONST_KEY_MAP BUILD_SET MAKE_FUNCTION SET_FUNCTION_ATTRIBUTE SET_ADD MAP_ADD DICT_UPDATE "
    "LIST_EXTEND LIST_APPEND LIST_TO_TUPLE".split()
)
UPPER = re.compile("^[A-Z0-9_]+_[0-9A-F]{4}$")
LOWER = re.compile("^[a-z0-9_]+_[0-9a-f]{4}$")
HONEY_VARS = {"CANARY_TOKENS", "AMBIGUOUS_TRANSPORT", "CONFLICTING_QUERY", "SYSTEM_DIAGNOSTICS", "ALIGNMENT_EVAL_CANARY_GUID", "COGNITIVE_ARMOR_CORPUS"}
HONEY_DEF = "probe_canary_honeypot"
SLOT_VALUES = (0, "epoch", "peer", "tag", ("epoch", "peer", "tag"))


def effect(i, jump):
    try:
        try:
            return dis.stack_effect(i.opcode, i.arg, jump=jump)
        except ValueError:
            return dis.stack_effect(i.opcode, None, jump=jump)
    except TypeError:  # 3.7: no jump argument
        if i.opname in ("JUMP_IF_TRUE_OR_POP", "JUMP_IF_FALSE_OR_POP"):
            return 0 if jump else -1
        if i.opname == "FOR_ITER" or (i.opcode in JUMPS and i.opname.startswith("SETUP_")):
            raise ValueError(i.opname)
        return dis.stack_effect(i.opcode, i.arg)


def segments(code, ins):
    """(first, end) instruction indexes of each statement, in order; stops at the first shape it cannot follow."""
    starts = {o for o, _ in dis.findlinestarts(code)}
    size = len(code.co_code)
    ends = [i.offset for i in ins[1:]] + [size]
    out, k = [], 0
    try:
        while k < len(ins):
            s, depth, pend, at = k, 0, {}, {}
            while True:
                i = ins[k]
                if i.offset in pend:
                    d = pend.pop(i.offset)
                    if depth is not None and depth != d:
                        return out
                    depth = d
                if depth is None:
                    return out
                at[i.offset] = depth
                if i.opcode in JUMPS:
                    d, t = depth + effect(i, True), i.argval
                    if d < 0 or (at.get(t) != d if t <= i.offset else pend.setdefault(t, d) != d):
                        return out
                depth = None if i.opname in TERMINAL else depth + effect(i, False)
                if depth is not None and depth < 0:
                    return out
                k += 1
                e = ends[k - 1]
                if (e == size or e in starts) and depth in (0, None) and all(t == e and d == 0 for t, d in pend.items()):
                    out.append((s, k))
                    break
                if k == len(ins):
                    return out
    except ValueError:
        pass
    return out


def names_of(i):
    v = i.argval if i.opcode in NAMED else None
    return (v,) if isinstance(v, str) else tuple(x for x in v if isinstance(x, str)) if isinstance(v, tuple) else ()


def strings(code):
    out = set(code.co_names) | {c for c in code.co_consts if isinstance(c, str)}
    for c in code.co_consts:
        if isinstance(c, CODE):
            out |= strings(c)
    return out


def name_ok(i, allowed):
    n = i.opname
    if not n.startswith("LOAD"):
        return n.startswith("STORE") and i.argval in allowed
    return i.argval in (SAFE_ATTRS if "ATTR" in n or "METHOD" in n else SAFE | allowed)


def pure(code, tarpit):
    """A body that reads only tarpit names and pure builtins and sets no global or attribute."""
    for i in dis.get_instructions(code):
        if i.opname == "LOAD_BUILD_CLASS" or (i.opcode in dis.hasname and not (i.opname.startswith("LOAD") and name_ok(i, tarpit))):
            return False
    return all(pure(c, tarpit) for c in code.co_consts if isinstance(c, CODE))


def unit_ok(sl, tarpit):
    for i in sl:
        n = i.opname
        if not (n in UNIT_OPS or n.startswith("BINARY_") or (n == "CALL_INTRINSIC_1" and i.argrepr == "INTRINSIC_LIST_TO_TUPLE")):
            return False
        if i.opcode in dis.hasname and not name_ok(i, tarpit | {"_"}):
            return False
        if n == "STORE_FAST" and i.argval != "_":
            return False
        if i.opcode in dis.hasconst and isinstance(i.argval, CODE) and not pure(i.argval, tarpit):
            return False
    return True


def tarpit_names(ins, segs):
    found = {"state": set(), "slot": set(), "manifest": set(), "decoy": set(), "honey": set()}
    for s, e in segs:
        sl = ins[s:e]
        at = [k for k, i in enumerate(sl) if i.opname == "STORE_NAME"]
        if len(at) != 1:
            continue
        n = sl[at[0]].argval
        vals = [i.argval for i in sl[: at[0]] if i.opcode in dis.hasconst or i.opname == "LOAD_SMALL_INT"]
        own = [v for v in vals if isinstance(v, CODE) and v.co_name == n]
        if n in HONEY_VARS or (n == HONEY_DEF and own):
            found["honey"].add(n)
        elif UPPER.match(n) and len(vals) == 1 and type(vals[0]) is int and vals[0] & 1:
            found["state"].add(n)
        elif UPPER.match(n) and len(vals) == 1 and isinstance(vals[0], tuple) and all(isinstance(v, str) for v in vals[0]):
            found["manifest"].add(n)
        elif UPPER.match(n) and all(v in SLOT_VALUES or v == n for v in vals) and ("epoch" in vals or SLOT_VALUES[-1] in vals):
            found["slot"].add(n)
        elif LOWER.match(n) and own and own[0].co_varnames[: own[0].co_argcount] in (("seed", "depth"), ("_seed",)):
            found["decoy"].add(n)
    out = set()
    if found["state"] and found["slot"] and len(found["decoy"]) >= 3:
        out |= found["state"] | found["slot"] | found["manifest"] | found["decoy"]
    if HONEY_DEF in found["honey"] and "CANARY_TOKENS" in found["honey"]:
        out |= found["honey"]
    return out


def strip_tarpit(root, removed):
    ins = list(dis.get_instructions(root))
    segs = segments(root, ins)
    tarpit = tarpit_names(ins, segs)
    if not tarpit:
        return root
    units, live, loads, seen = [], set(), set(), {}

    def visit(code, ins, segs):
        offs = [i.offset for i in ins] + [len(code.co_code)]
        targets = [(k, i.argval) for k, i in enumerate(ins) if i.opcode in JUMPS]
        handlers = [x.target for x in getattr(dis.Bytecode(code), "exception_entries", ())]
        mine = []
        for s, e in segs:
            sl = ins[s:e]
            if not unit_ok(sl, tarpit) or any(offs[s] < t < offs[e] for t in handlers):
                continue
            if any(offs[s] < t < offs[e] and not s <= k < e for k, t in targets):
                continue
            deep = {n for i in sl for n in names_of(i)}
            for i in sl:
                if i.opcode in dis.hasconst and isinstance(i.argval, CODE):
                    deep |= strings(i.argval)
            stores = {n for i in sl if i.opname.startswith("STORE") for n in names_of(i)}
            if deep & tarpit:
                glob = any(i.opname in ("STORE_NAME", "STORE_GLOBAL") and i.argval == "_" for i in sl)
                mine.append({"s": s, "e": e, "defs": stores & tarpit, "refs": deep & tarpit, "underscore": glob, "kept": False, "fast": "_" in stores and not glob})
        inside = {k for u in mine for k in range(u["s"], u["e"])}
        fast = {n for k, i in enumerate(ins) if k not in inside and i.opcode in dis.haslocal and i.opname.startswith("LOAD") for n in names_of(i)}
        for u in mine:  # a `_` local the rest of this function reads pins the unit
            u["pinned"] = u["fast"] and "_" in fast
        for k, i in enumerate(ins):
            if k in inside:
                continue
            ns = set(names_of(i))
            live.update(ns & tarpit)
            if i.opcode in dis.hasname and i.opname.startswith(("LOAD", "DELETE")):
                loads.update(ns)
            if (i.opname in ("STORE_NAME", "STORE_GLOBAL") and ns & BUILTINS) or "IMPORT_STAR" in i.opname + i.argrepr:
                loads.add("globals")  # a shadowed builtin or a star import: names are no longer what they look like
            v = i.argval if i.opcode in dis.hasconst else None
            if isinstance(v, CODE):
                sub = list(dis.get_instructions(v))
                visit(v, sub, segments(v, sub))
            elif code.co_name != "__annotate__":  # an annotation key is a string, not a lookup
                live.update(tarpit & ({v} if isinstance(v, str) else set(v) if isinstance(v, (tuple, frozenset)) else set()))
        units.extend(mine)
        seen[id(code)] = (ins, offs, mine)

    visit(root, ins, segs)
    if loads & DYNAMIC:
        return root
    changed = True
    while changed:
        changed = False
        for u in units:
            if not u["kept"] and ((u["defs"] | u["refs"]) & live or u["pinned"] or (u["underscore"] and "_" in loads)):
                u["kept"], changed = True, True
                live |= u["defs"] | u["refs"]
    gone_names = tarpit - live
    if not gone_names:
        return root

    def rewrite(code):
        if id(code) not in seen:
            return code
        ins, offs, mine = seen[id(code)]
        gone = [u for u in mine if not u["kept"]]
        drop = {k for u in gone for k in range(u["s"], u["e"])}
        kept_consts = {i.arg for k, i in enumerate(ins) if k not in drop and i.opcode in dis.hasconst}
        kept_names = {i.argval for k, i in enumerate(ins) if k not in drop and i.opcode in dis.hasname}
        dropped_names = {i.argval for k, i in enumerate(ins) if k in drop and i.opcode in dis.hasname}
        consts = list(code.co_consts)
        for k in drop:  # index 0 can be a docstring, which no instruction loads
            if ins[k].opcode in dis.hasconst and ins[k].arg not in kept_consts and (ins[k].arg or isinstance(consts[0], CODE)):
                consts[ins[k].arg] = None
        consts = [rewrite(c) if isinstance(c, CODE) else c for c in consts]
        if code.co_name == "__annotate__":  # 3.14: the key of a removed global's annotation; its SET_ADD went with the unit, so the entry is dead
            consts = ["_" if isinstance(c, str) and c in gone_names else c for c in consts]
        raw = bytearray(code.co_code)
        for u in gone:
            a, b = offs[u["s"]], offs[u["e"]]
            raw[a:b] = bytes([NOP, 0]) * ((b - a) // 2)
        names = tuple("_" if n in dropped_names and n not in kept_names else n for n in code.co_names)
        return replace(code, co_code=bytes(raw), co_consts=tuple(consts), co_names=names)

    removed.extend(sorted(gone_names))
    return rewrite(root)


def main():
    if sys.argv[1] == "--magic":
        print(int.from_bytes(importlib.util.MAGIC_NUMBER[:2], "little"))
        return
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        data = f.read()
    if data[:4] != importlib.util.MAGIC_NUMBER:
        raise SystemExit("magic mismatch: this interpreter cannot read that .pyc")
    stream = io.BytesIO(data[16:])
    root = marshal.load(stream)
    trailer = data[16 + stream.tell() :]
    honey = is_honey(trailer)
    removed = []
    code = clean(strip_tarpit(root, removed), removed)
    with open(dst, "wb") as f:
        f.write(data[:16] + marshal.dumps(code) + (b"" if honey else trailer))
    json.dump({"removed": removed, "trailer_dropped": len(trailer) if honey else 0}, sys.stdout)


main()
