#!/bin/bash
# Crea las DBs adicionales listadas en POSTGRES_EXTRA_DBS (CSV)
# Ejecutado solo la primera vez que se inicializa el volumen (Postgres init pattern).

set -e

if [ -z "${POSTGRES_EXTRA_DBS}" ]; then
  echo "No extra DBs requested."
  exit 0
fi

IFS=',' read -ra DBS <<< "${POSTGRES_EXTRA_DBS}"
for DB in "${DBS[@]}"; do
  DB_TRIMMED="$(echo "$DB" | xargs)"
  if [ -z "$DB_TRIMMED" ]; then continue; fi
  echo "Creating database: $DB_TRIMMED"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE "$DB_TRIMMED";
    GRANT ALL PRIVILEGES ON DATABASE "$DB_TRIMMED" TO "$POSTGRES_USER";
EOSQL
done
echo "Extra DBs created."
