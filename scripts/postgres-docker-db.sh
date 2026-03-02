#!/usr/bin/env bash

# Export/import a PostgreSQL database between Docker containers.
#
# Commands:
#   export [dump.sql.gz]         Export from source Postgres container to a gzipped SQL file
#   import <dump.sql.gz|.sql>    Import a dump file into target Postgres container
#   transfer                     Stream dump directly from source container into target container
#
# Environment variables:
#   SOURCE_CONTAINER (default: sootio-postgres)
#   SOURCE_DB        (default: POSTGRES_DB or sootio)
#   SOURCE_USER      (default: POSTGRES_USER or sootio)
#   SOURCE_PASSWORD  (default: POSTGRES_PASSWORD or sootio)
#   TARGET_CONTAINER (default: sootio-postgres)
#   TARGET_DB        (default: POSTGRES_DB or sootio)
#   TARGET_USER      (default: POSTGRES_USER or sootio)
#   TARGET_PASSWORD  (default: POSTGRES_PASSWORD or sootio)
#   DUMP_DIR         (default: ./db_dumps)
#   DROP_TARGET_DB   (true/false, default: false)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    log_error "Required command not found: $1"
    exit 1
  }
}

usage() {
  cat <<USAGE
Postgres Docker DB Export/Import

Usage:
  $0 export [dump.sql.gz]
  $0 import <dump.sql.gz|dump.sql>
  $0 transfer

Examples:
  # Export from a running source container
  SOURCE_CONTAINER=pg-src SOURCE_DB=appdb SOURCE_USER=postgres SOURCE_PASSWORD=secret \\
    $0 export ./db_dumps/appdb.sql.gz

  # Import to a target container (drop DB first)
  TARGET_CONTAINER=pg-dst TARGET_DB=appdb TARGET_USER=postgres TARGET_PASSWORD=secret \\
  DROP_TARGET_DB=true $0 import ./db_dumps/appdb.sql.gz

  # Direct container-to-container transfer (no dump file written)
  SOURCE_CONTAINER=pg-src TARGET_CONTAINER=pg-dst SOURCE_DB=appdb TARGET_DB=appdb \\
  SOURCE_USER=postgres TARGET_USER=postgres SOURCE_PASSWORD=secret TARGET_PASSWORD=secret \\
    $0 transfer
USAGE
}

SOURCE_CONTAINER="${SOURCE_CONTAINER:-sootio-postgres}"
SOURCE_DB="${SOURCE_DB:-${POSTGRES_DB:-sootio}}"
SOURCE_USER="${SOURCE_USER:-${POSTGRES_USER:-sootio}}"
SOURCE_PASSWORD="${SOURCE_PASSWORD:-${POSTGRES_PASSWORD:-sootio}}"

TARGET_CONTAINER="${TARGET_CONTAINER:-sootio-postgres}"
TARGET_DB="${TARGET_DB:-${POSTGRES_DB:-sootio}}"
TARGET_USER="${TARGET_USER:-${POSTGRES_USER:-sootio}}"
TARGET_PASSWORD="${TARGET_PASSWORD:-${POSTGRES_PASSWORD:-sootio}}"

DUMP_DIR="${DUMP_DIR:-./db_dumps}"
DROP_TARGET_DB="${DROP_TARGET_DB:-false}"

ensure_container_running() {
  local container="$1"

  if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
      log_info "Starting container: $container"
      docker start "$container" >/dev/null
    else
      log_error "Container not found: $container"
      exit 1
    fi
  fi
}

wait_for_pg() {
  local container="$1"
  local user="$2"
  local db="$3"
  local password="$4"
  local max_tries="${5:-30}"

  log_info "Waiting for Postgres in $container..."
  for _ in $(seq 1 "$max_tries"); do
    if docker exec -e PGPASSWORD="$password" "$container" \
      pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  log_error "Postgres in $container did not become ready"
  exit 1
}

psql_in_container() {
  local container="$1"
  local user="$2"
  local db="$3"
  local password="$4"
  shift 4

  docker exec -e PGPASSWORD="$password" "$container" \
    psql -v ON_ERROR_STOP=1 -U "$user" -d "$db" "$@"
}

db_exists() {
  local container="$1"
  local user="$2"
  local db_name="$3"
  local password="$4"

  local exists
  exists=$(docker exec -e PGPASSWORD="$password" "$container" \
    psql -tA -U "$user" -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '${db_name//\'/\'\'}';" | tr -d '[:space:]')
  [[ "$exists" == "1" ]]
}

create_db_if_missing() {
  local container="$1"
  local user="$2"
  local db_name="$3"
  local password="$4"

  if db_exists "$container" "$user" "$db_name" "$password"; then
    log_info "Target database exists: $db_name"
    return 0
  fi

  log_info "Creating target database: $db_name"
  docker exec -e PGPASSWORD="$password" "$container" \
    psql -v ON_ERROR_STOP=1 -U "$user" -d postgres -c "CREATE DATABASE \"$db_name\";" >/dev/null
}

drop_and_recreate_db() {
  local container="$1"
  local user="$2"
  local db_name="$3"
  local password="$4"

  log_warn "Dropping and recreating target database: $db_name"
  docker exec -e PGPASSWORD="$password" "$container" psql -v ON_ERROR_STOP=1 -U "$user" -d postgres <<SQL >/dev/null
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$db_name' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$db_name";
CREATE DATABASE "$db_name";
SQL
}

run_export() {
  local dump_file="${1:-}"
  local timestamp

  mkdir -p "$DUMP_DIR"
  timestamp="$(date +%Y%m%d_%H%M%S)"
  dump_file="${dump_file:-${DUMP_DIR}/${SOURCE_DB}_${timestamp}.sql.gz}"

  ensure_container_running "$SOURCE_CONTAINER"
  wait_for_pg "$SOURCE_CONTAINER" "$SOURCE_USER" "$SOURCE_DB" "$SOURCE_PASSWORD"

  log_info "Exporting ${SOURCE_DB} from ${SOURCE_CONTAINER} -> ${dump_file}"
  docker exec -e PGPASSWORD="$SOURCE_PASSWORD" "$SOURCE_CONTAINER" \
    pg_dump -U "$SOURCE_USER" -d "$SOURCE_DB" --no-owner --no-acl --clean --if-exists \
    | gzip > "$dump_file"

  local size
  size=$(du -h "$dump_file" | cut -f1)
  log_info "Export complete: $dump_file ($size)"
}

run_import() {
  local import_file="${1:-}"

  if [[ -z "$import_file" ]]; then
    log_error "Import file is required"
    usage
    exit 1
  fi

  if [[ ! -f "$import_file" ]]; then
    log_error "File not found: $import_file"
    exit 1
  fi

  ensure_container_running "$TARGET_CONTAINER"
  wait_for_pg "$TARGET_CONTAINER" "$TARGET_USER" "postgres" "$TARGET_PASSWORD"

  if [[ "$DROP_TARGET_DB" == "true" ]]; then
    drop_and_recreate_db "$TARGET_CONTAINER" "$TARGET_USER" "$TARGET_DB" "$TARGET_PASSWORD"
  else
    create_db_if_missing "$TARGET_CONTAINER" "$TARGET_USER" "$TARGET_DB" "$TARGET_PASSWORD"
  fi

  log_info "Importing ${import_file} -> ${TARGET_CONTAINER}:${TARGET_DB}"
  if [[ "$import_file" == *.gz ]]; then
    gunzip -c "$import_file" | docker exec -i -e PGPASSWORD="$TARGET_PASSWORD" "$TARGET_CONTAINER" \
      psql -v ON_ERROR_STOP=1 -U "$TARGET_USER" -d "$TARGET_DB"
  else
    docker exec -i -e PGPASSWORD="$TARGET_PASSWORD" "$TARGET_CONTAINER" \
      psql -v ON_ERROR_STOP=1 -U "$TARGET_USER" -d "$TARGET_DB" < "$import_file"
  fi

  log_info "Import complete"
}

run_transfer() {
  ensure_container_running "$SOURCE_CONTAINER"
  ensure_container_running "$TARGET_CONTAINER"
  wait_for_pg "$SOURCE_CONTAINER" "$SOURCE_USER" "$SOURCE_DB" "$SOURCE_PASSWORD"
  wait_for_pg "$TARGET_CONTAINER" "$TARGET_USER" "postgres" "$TARGET_PASSWORD"

  if [[ "$DROP_TARGET_DB" == "true" ]]; then
    drop_and_recreate_db "$TARGET_CONTAINER" "$TARGET_USER" "$TARGET_DB" "$TARGET_PASSWORD"
  else
    create_db_if_missing "$TARGET_CONTAINER" "$TARGET_USER" "$TARGET_DB" "$TARGET_PASSWORD"
  fi

  log_info "Streaming ${SOURCE_CONTAINER}:${SOURCE_DB} -> ${TARGET_CONTAINER}:${TARGET_DB}"
  docker exec -e PGPASSWORD="$SOURCE_PASSWORD" "$SOURCE_CONTAINER" \
    pg_dump -U "$SOURCE_USER" -d "$SOURCE_DB" --no-owner --no-acl --clean --if-exists \
    | docker exec -i -e PGPASSWORD="$TARGET_PASSWORD" "$TARGET_CONTAINER" \
      psql -v ON_ERROR_STOP=1 -U "$TARGET_USER" -d "$TARGET_DB"

  log_info "Transfer complete"
}

main() {
  require_cmd docker
  require_cmd gzip
  require_cmd gunzip

  case "${1:-}" in
    export)
      run_export "${2:-}"
      ;;
    import)
      run_import "${2:-}"
      ;;
    transfer)
      run_transfer
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
