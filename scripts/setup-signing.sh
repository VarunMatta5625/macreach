#!/bin/bash
# Creates a dedicated keychain with a self-signed code-signing cert so the helper's
# code signature (and therefore its TCC grants) stays stable across rebuilds. No user password needed.
set -euo pipefail
D="$HOME/Library/Application Support/MacReach/signing"
KC="$D/macreach-signing.keychain-db"
mkdir -p "$D"; chmod 700 "$D"
if [ -f "$D/identity.txt" ] && [ -f "$KC" ]; then echo "signing already set up: $(cat "$D/identity.txt")"; exit 0; fi
PW="$(openssl rand -hex 24)"
umask 077
echo -n "$PW" > "$D/kc.pw"
cat > "$D/openssl.cnf" <<CNF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=MacReach Local Signing
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/key.pem" -out "$D/cert.pem" -days 3650 -config "$D/openssl.cnf" 2>/dev/null
openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -out "$D/id.p12" -passout pass:"$PW" -legacy 2>/dev/null || \
openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -out "$D/id.p12" -passout pass:"$PW"
security create-keychain -p "$PW" "$KC"
security set-keychain-settings "$KC"   # no auto-lock
security unlock-keychain -p "$PW" "$KC"
security import "$D/id.p12" -k "$KC" -P "$PW" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null
HASH="$(openssl x509 -in "$D/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
echo -n "$HASH" > "$D/identity.txt"
rm -f "$D/key.pem" "$D/id.p12"
echo "signing ready: $HASH"
