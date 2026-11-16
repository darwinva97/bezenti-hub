#!/usr/bin/env bash
# TEST-ONLY TLS material for the fake OpenBao in src/server/*.test.ts. Nothing here protects
# anything: the keys are public on purpose. Run from this directory to regenerate (openssl 3).
set -euo pipefail
days=36500
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ca() {
  key "$work/$1.key"
  openssl req -x509 -new -key "$work/$1.key" -sha256 -days "$days" \
    -subj "/CN=$2" -out "$1.pem"
}
ca test-only-ca "T3 Code TEST-ONLY OpenBao CA"
ca test-only-other-ca "T3 Code TEST-ONLY unrelated CA"

leaf() {
  local name=$1 subject=$2 ext=$3
  key "$name.key.pem"
  openssl req -new -key "$name.key.pem" -subj "/CN=$subject" -out "$work/$name.csr"
  printf '%s\n' "$ext" >"$work/$name.ext"
  openssl x509 -req -in "$work/$name.csr" -CA test-only-ca.pem -CAkey "$work/test-only-ca.key" \
    -CAcreateserial -CAserial "$work/ca.srl" -days "$days" -sha256 \
    -extfile "$work/$name.ext" -out "$name.pem" 2>/dev/null
}
leaf test-only-server "127.0.0.1" "subjectAltName=IP:127.0.0.1,DNS:localhost
extendedKeyUsage=serverAuth"
leaf test-only-client "t3-hub-test-client" "extendedKeyUsage=clientAuth"
