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
# BLA 3.2.2 formats: DEX, IL2CPP metadata, .NET, ZIP and APK (manifest, R8, xref decoys), Bun sidecar, emitted headers.
node "$here/mkin.mjs" "$1"
p bla-classes.dex "$here/src/classes.dex" --intensity balanced
p bla-global-metadata.dat "$here/src/global-metadata.dat" --intensity balanced
p bla-App.dll "$here/src/App.dll" --intensity balanced
p bla-app.zip "$here/src/app.zip" --intensity balanced
p bla-app.apk "$here/src/app.apk" --intensity stealth
p bla-bunapp "$here/src/bunapp" --intensity stealth --sidecar-entangle
rm "$here/bla-bunapp" # BLA leaves the binary byte-exact; only the sidecar and its note are BLA's
for l in c rust go; do $bla emit-headers --lang $l --seed fx-1 --intensity balanced -o "$here/bla-shield.$l" >/dev/null; done
mv "$here/bla-shield.c" "$here/bla_shield.h"; mv "$here/bla-shield.rust" "$here/bla_shield.rs"; mv "$here/bla-shield.go" "$here/bla_shield.go"
# JS shapes (shapes322.test.ts): a customer-local Math binding, and the `bla_encrypt_strings` stub (MCP/API only, no CLI command).
p mathlocal.bla.js "$here/src/mathlocal.js" --intensity stealth
enc=$(mktemp -d)
node -e 'import(process.argv[1]).then((m) => m.encryptStrings({ path: process.argv[2], seed: "fx-1", outDir: process.argv[3] }))' "$1/dist/index.js" "$here/src/vault.js" "$enc"
mv "$enc/vault.js" "$here/vault.bla.js"; rmdir "$enc"
p ledger.bankrupt.bla.py "$here/src/ledger.py" --intensity bankrupt
