#!/bin/bash
# PostgreSQL pg_hba.conf initialization script for Docker
set -e

echo "Configuring pg_hba.conf for Docker network access..."

# Append Docker network access rules to pg_hba.conf
cat >> "${PGDATA}/pg_hba.conf" <<EOF

# Docker network connections (added by init script)
host all all 172.18.0.0/16 scram-sha-256
host all all 0.0.0.0/0 scram-sha-256
EOF

echo "pg_hba.conf configured successfully!"
