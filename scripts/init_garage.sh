#!/bin/sh
# Bootstrap a single-node Garage cluster for the S3 plugin test (Garage v1.0):
#   - assign this node to a zone and apply the layout
#   - ensure the `hyperdeck` bucket exists
#   - create (once) an API key and allow it read/write on the bucket
#   - persist the key credentials to /var/lib/garage/creds.json
#
# Garage only shows a key's secret at creation time, so we persist it to the
# shared data volume; subsequent runs reuse the saved credentials.
set -eu

# v1.0 reads the config from GARAGE_CONFIG_FILE (not GARAGE_CONFIG).
GARAGE_CONFIG_FILE=/garage.toml
export GARAGE_CONFIG_FILE
BUCKET=hyperdeck
KEYNAME=hyperdeck
ZONE=dc1
CREDS=/var/lib/garage/creds.json
RPC_PORT=3901

echo "waiting for garage rpc..."
for _ in $(seq 1 60); do
  if garage node id >/dev/null 2>&1; then break; fi
  sleep 2
done

# `garage node id` prints `<node-id>@<ip>:<port>`; keep only the node id.
NODE_ID=$(garage node id 2>/dev/null | sed 's/@.*//' | sed '/^[[:space:]]*$/d' | head -1 | tr -d '[:space:]')
if [ -n "$NODE_ID" ]; then
  echo "node id: $NODE_ID"
  RPC_HOST="$NODE_ID@garage:$RPC_PORT"
  echo "assigning node to zone $ZONE"
  garage --rpc-host "$RPC_HOST" layout assign "$NODE_ID" --zone "$ZONE" -c 10000000000 2>&1 | head -5 || true
  # `layout show` prints the exact version to pass to `layout apply`.
  VERSION=$(garage --rpc-host "$RPC_HOST" layout show 2>/dev/null | grep -oE 'layout apply --version [0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ -n "$VERSION" ]; then
    garage --rpc-host "$RPC_HOST" layout apply --version "$VERSION" 2>&1 | head -5 || true
  fi
  # Give the cluster a moment to converge on the new layout.
  sleep 3
else
  echo "WARNING: could not determine Garage node id"
  RPC_HOST=""
fi

# Create the API key once and persist its secret.
if [ ! -f "$CREDS" ]; then
  if [ -n "$RPC_HOST" ]; then
    OUT=$(garage --rpc-host "$RPC_HOST" key create "$KEYNAME" 2>&1)
  else
    OUT=$(garage key create "$KEYNAME" 2>&1)
  fi
  ACCESS=$(printf '%s\n' "$OUT" | sed -n 's/.*Key ID:[[:space:]]*\(.*\)$/\1/p' | head -1 | tr -d '[:space:]')
  SECRET=$(printf '%s\n' "$OUT" | sed -n 's/.*Secret key:[[:space:]]*\(.*\)$/\1/p' | head -1 | tr -d '[:space:]')
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
if [ -n "$RPC_HOST" ]; then
  garage --rpc-host "$RPC_HOST" bucket create "$BUCKET" 2>&1 | head -3 || true
  garage --rpc-host "$RPC_HOST" bucket allow "$BUCKET" --read --write --key "$KEYNAME" 2>&1 | head -3 || true
else
  garage bucket create "$BUCKET" 2>&1 | head -3 || true
  garage bucket allow "$BUCKET" --read --write --key "$KEYNAME" 2>&1 | head -3 || true
fi

echo "garage s3 backend ready"
