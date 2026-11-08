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
# Parses with marshal only; never imports or runs the target.
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
    return code.replace(co_consts=tuple(consts[:end]))


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
    code = clean(root, removed)
    with open(dst, "wb") as f:
        f.write(data[:16] + marshal.dumps(code) + (b"" if honey else trailer))
    json.dump({"removed": removed, "trailer_dropped": len(trailer) if honey else 0}, sys.stdout)


main()
