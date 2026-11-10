#!/usr/bin/env bash
# Read-only isolation diagnostic. No hostile page is opened and no verifier
# certificate is issued. Uses an existing image and does not alter the firewall.
set -Eeuo pipefail
printf 'host network namespace: '; readlink /proc/self/ns/net
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true nginx:1.28-alpine sh -c '
  printf "container network namespace: "; readlink /proc/self/ns/net
  cat /proc/net/dev
  cat /proc/net/route
  test "$(ls /sys/class/net | tr "\n" " ")" = "lo "
'
printf 'Network-none interface check passed. Browser sandbox and mediated HTTPS/UDP remain separate gates.\n'
if [[ ${PROBE_BROWSER_SANDBOX:-0} == 1 ]]; then
  # Existing laboratory image, never a product dependency. Chromium's sandbox
  # must remain enabled; failure is an actual blocker, never a positive verdict.
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true --user pwuser mcr.microsoft.com/playwright:v1.63.0-noble /ms-playwright/chromium-1243/chrome-linux64/chrome --headless --disable-gpu --dump-dom about:blank
fi
