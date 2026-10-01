#!/bin/sh
# Bootstrap a single-node Garage cluster for the S3 plugin test:
#   - allow this node in the cluster
#   - ensure the `hyperdeck` bucket exists
#   - create (once) an API key and allow it read/write on the bucket
#   - persist the key credentials to /var/lib/garage/creds.json
#
# Garage only shows a key's secret at creation time, so we persist it to the
# shared data volume; subsequent runs reuse the saved credentials.
set -eu

GARAGE_CONFIG=/garage.toml
export GARAGE_CONFIG
BUCKET=hyperdeck
KEYNAME=hyperdeck
CREDS=/var/lib/garage/creds.json

echo "waiting for garage rpc..."
for _ in $(seq 1 60); do
  if garage node info >/dev/null 2>&1; then break; fi
  sleep 2
done

# Allow this node (single-node cluster bootstrap). Safe to repeat.
NODE_ID=$(garage node info | sed -n 's/.*Node ID:[[:space:]]*\(.*\)$/\1/p' | head -1 | tr -d '[:space:]')
if [ -n "$NODE_ID" ]; then
  garage node allow "$NODE_ID" 2>/dev/null || true
fi

# Create the API key once and persist its secret.
if [ ! -f "$CREDS" ]; then
  OUT=$(garage key create "$KEYNAME")
  ACCESS=$(printf '%s\n' "$OUT" | sed -n 's/.*Access Key ID:[[:space:]]*\(.*\)$/\1/p' | head -1 | tr -d '[:space:]')
  SECRET=$(printf '%s\n' "$OUT" | sed -n 's/.*Secret Key:[[:space:]]*\(.*\)$/\1/p' | head -1 | tr -d '[:space:]')
  if [ -n "$ACCESS" ] && [ -n "$SECRET" ]; then
    printf '{"access_key_id":"%s","secret_access_key":"%s"}\n' "$ACCESS" "$SECRET" > "$CREDS"
    echo "==================== GARAGE S3 CREDENTIALS ===================="
    echo "$OUT"
    echo "Use these in the S3 storage destination:"
    echo "  endpoint: http://garage:3900   region: garage   bucket: hyperdeck"
    echo "=============================================================="
  else
    echo "FAILED to parse garage key credentials:"; echo "$OUT"
  fi
else
  echo "garage key already created; credentials at $CREDS"
fi

# Ensure the bucket exists and the key is allowed on it.
garage bucket create "$BUCKET" 2>/dev/null || true
garage bucket allow "$BUCKET" --read --write --key "$KEYNAME" 2>/dev/null || true

echo "garage s3 backend ready"
