#!/bin/sh
# ─────────────────────────────────────────────────────────────
# Publish the app to https://fallhike.pages.dev (Cloudflare Pages).
# Run from the repo root on an up-to-date main, with CLOUDFLARE_API_TOKEN set:
#   git checkout main && git pull && ./deploy-site.sh
# The old link (rmbk18.github.io/Trail-Season) updates by itself from main.
# ─────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
# Only the website files: no phase2/ Workers, no README
cp -r index.html manifest.json sw.js css js img fonts icons "$DIR"/
npx --yes wrangler@4 pages deploy "$DIR" --project-name fallhike --branch main --commit-dirty=true
