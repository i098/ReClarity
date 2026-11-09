#!/bin/sh
# Rebuild the *.bla.* files from src/ with a real BLA build. Usage: regen.sh /path/to/bla-checkout (built: `bun install && tsc -p tsconfig.build.json`).
# Output is BLA 3.2.2 (commit 38d26d5), seed fx-1. Needs node.
set -eu
bla="node $1/dist/cli.js"
here=$(cd "$(dirname "$0")" && pwd)
p() { out=$1; shift; $bla protect "$@" --seed fx-1 -o "$here/$out" >/dev/null; }
p app.bla.js "$here/src/app.js" --intensity bankrupt
p app.bla-llm.js "$here/src/app.js" --intensity stealth --llm-directives
p app.bla-all.js "$here/src/app.js" --intensity balanced --llm-directives --weave-decoys --self-seal --sidecar-entangle
p ledger.bla.py "$here/src/ledger.py" --intensity balanced --llm-directives --weave-decoys
for f in k.ptx Info.plist fw.uf2 app.js.map Tiny.class; do p "bla-$f" "$here/src/$f" --intensity balanced; done
