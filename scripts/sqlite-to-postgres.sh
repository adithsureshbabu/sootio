#!/bin/bash
#
# Convert SQLite cache databases to Postgres and set up a local Postgres container.
#
# Usage: ./scripts/sqlite-to-postgres.sh
#

set -e

# Configuration
CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
POSTGRES_CONTAINER="${SOOTIO_POSTGRES_CONTAINER:-sootio-postgres}"
SOOTIO_NETWORK="${SOOTIO_NETWORK:-sootio-network}"
SOOTIO_VOLUME="${SOOTIO_DATA_VOLUME:-sootio-data}"
POSTGRES_DB="${POSTGRES_DB:-sootio}"
POSTGRES_USER="${POSTGRES_USER:-sootio}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-sootio}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
PGDATA_SUBDIR="${POSTGRES_PGDATA_SUBDIR:-postgres}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Sootio SQLite -> Postgres Migration ===${NC}"

echo -e "${YELLOW}Checking Docker...${NC}"
if ! command -v docker >/dev/null 2>&1; then
  echo -e "${RED}Error: docker is not installed or not in PATH${NC}"
  exit 1
fi

# Ensure network exists
if ! docker network ls --format '{{.Name}}' | grep -q "^${SOOTIO_NETWORK}$"; then
  echo -e "${YELLOW}Creating Docker network: ${SOOTIO_NETWORK}${NC}"
  docker network create "${SOOTIO_NETWORK}"
fi

# Ensure volume exists
if ! docker volume ls --format '{{.Name}}' | grep -q "^${SOOTIO_VOLUME}$"; then
  echo -e "${YELLOW}Creating Docker volume: ${SOOTIO_VOLUME}${NC}"
  docker volume create "${SOOTIO_VOLUME}"
fi

# Ensure app container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}Starting container: ${CONTAINER_NAME}${NC}"
    docker start "${CONTAINER_NAME}"
    sleep 3
  else
    echo -e "${RED}Error: container '${CONTAINER_NAME}' not found${NC}"
    exit 1
  fi
fi

# Checkpoint WAL files to avoid partial reads
for db in cache.db hash-cache.db; do
  docker exec "${CONTAINER_NAME}" sh -c "if [ -f /app/data/${db} ]; then sqlite3 /app/data/${db} 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true; fi"
done

# Start Postgres container if needed
if ! docker ps --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    echo -e "${YELLOW}Starting Postgres container: ${POSTGRES_CONTAINER}${NC}"
    docker start "${POSTGRES_CONTAINER}"
  else
    echo -e "${YELLOW}Creating Postgres container: ${POSTGRES_CONTAINER}${NC}"
    PORT_FLAG=""
    if [ -n "${POSTGRES_HOST_PORT}" ]; then
      PORT_FLAG="-p ${POSTGRES_HOST_PORT}:5432"
    fi

    docker run -d \
      --name "${POSTGRES_CONTAINER}" \
      --network "${SOOTIO_NETWORK}" \
      --restart unless-stopped \
      -v "${SOOTIO_VOLUME}:/var/lib/postgresql/data" \
      -e POSTGRES_DB="${POSTGRES_DB}" \
      -e POSTGRES_USER="${POSTGRES_USER}" \
      -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
      -e PGDATA="/var/lib/postgresql/data/${PGDATA_SUBDIR}" \
      ${PORT_FLAG} \
      "${POSTGRES_IMAGE}"
  fi
fi

# Ensure Postgres is on the app network
docker network connect "${SOOTIO_NETWORK}" "${POSTGRES_CONTAINER}" >/dev/null 2>&1 || true

# Wait for Postgres readiness
echo -e "${YELLOW}Waiting for Postgres to be ready...${NC}"
READY=false
for i in {1..30}; do
  if docker exec "${POSTGRES_CONTAINER}" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 2
done

if [ "${READY}" != "true" ]; then
  echo -e "${RED}Postgres did not become ready in time.${NC}"
  exit 1
fi

echo -e "${GREEN}Postgres is ready.${NC}"

MIGRATION_ENV=(
  -e POSTGRES_HOST="${POSTGRES_CONTAINER}"
  -e POSTGRES_PORT="5432"
  -e POSTGRES_DB="${POSTGRES_DB}"
  -e POSTGRES_USER="${POSTGRES_USER}"
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
  -e POSTGRES_SSL="${POSTGRES_SSL:-false}"
)

if [ -n "${MIGRATION_BATCH_SIZE}" ]; then
  MIGRATION_ENV+=( -e MIGRATION_BATCH_SIZE="${MIGRATION_BATCH_SIZE}" )
fi

# Run migration inside app container
echo -e "${YELLOW}Migrating SQLite cache data to Postgres...${NC}"
docker exec "${MIGRATION_ENV[@]}" "${CONTAINER_NAME}" node /app/scripts/sqlite-to-postgres.js

echo ""
echo -e "${GREEN}=== Migration Complete ===${NC}"
echo ""
echo "Next steps:"
echo "  1) Set CACHE_BACKEND=postgres in your .env"
echo "  2) Set POSTGRES_HOST=${POSTGRES_CONTAINER} (or your DB host) and credentials in .env"
echo "  3) Restart the Sootio container"
