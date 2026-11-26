#!/bin/bash
# usage: session.sh <dir> ; same model, same prompt for both arms
S=/sdc-disk/host-data/administrator/.treehouse/firstmate-8bf1b0/2/firstmate/data/reclarity-sbs-video
export PATH=/sdc-disk/host-data/administrator/.treehouse/firstmate-8bf1b0/2/firstmate/data/reclarity-autotrigger-e2e/e2e/tools/node_modules/.bin:$PATH
unset REA_ASAR_MAX_HEADER_BYTES
MSG="Use REA (rea analyze-javascript-application app.asar) to analyze this app and tell me what it does."
cd $S/$1; rm -rf .reclarity
echo "claude-opus-5-5 | Claude Code $(claude --version | cut -d' ' -f1) | REA 6.10.1 | dir: $1"
echo "FIRST MESSAGE: $MSG"
timeout 600 claude -p "$MSG" --model claude-opus-5-5 --permission-mode bypassPermissions --output-format stream-json --verbose --include-hook-events </dev/null 2>$S/$1.err | tee $S/$1.jsonl | python3 -u $S/show.py
echo "done"
