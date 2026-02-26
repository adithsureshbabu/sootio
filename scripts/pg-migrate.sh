#!/bin/bash

# PostgreSQL Database Migration Script
# Usage:
#   Export: ./pg-migrate.sh export
#   Import: ./pg-migrate.sh import <dump_file>

set -e
set -o pipefail

DB_NAME="sootio"
DUMP_DIR="./db_dumps"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="${DUMP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"
PG_CONTAINER="${PG_CONTAINER:-sootio-postgres}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log_error "Required command not found: $1"
        exit 1
    fi
}

ensure_container_running() {
    local container="$1"
    require_cmd docker

    if docker ps --format '{{.Names}}' | grep -qx "${container}"; then
        return 0
    fi

    if docker ps -a --format '{{.Names}}' | grep -qx "${container}"; then
        log_info "Starting Docker container: ${container}"
        docker start "${container}" >/dev/null
        return 0
    fi

    log_error "Docker container not found: ${container}"
    exit 1
}

parse_mode_args() {
    local mode_ref="$1"
    local container_ref="$2"
    shift 2

    while [ $# -gt 0 ]; do
        case "$1" in
            --docker)
                printf -v "${mode_ref}" '%s' "docker"
                ;;
            --container)
                shift
                if [ -z "${1:-}" ]; then
                    log_error "--container requires a value"
                    exit 1
                fi
                printf -v "${container_ref}" '%s' "$1"
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
        shift
    done
}

# Export function
export_db() {
    local TMP_DUMP_FILE
    local MODE="tcp"
    local CONTAINER="${PG_CONTAINER}"
    local -a DOCKER_ENV_ARGS=()

    parse_mode_args MODE CONTAINER "$@"

    log_info "Starting export of database: ${DB_NAME}"

    # Create dump directory if it doesn't exist
    mkdir -p "${DUMP_DIR}"

    if [ -z "$PGUSER" ]; then
        read -p "Source username (default: postgres): " PGUSER
        PGUSER=${PGUSER:-postgres}
    fi

    if [ "${MODE}" = "docker" ]; then
        ensure_container_running "${CONTAINER}"
        log_info "Using Docker container: ${CONTAINER}"
        DOCKER_ENV_ARGS=(-e "PGUSER=${PGUSER}" -e "DB_NAME=${DB_NAME}")
        if [ -n "${PGPASSWORD}" ]; then
            DOCKER_ENV_ARGS+=(-e "PGPASSWORD=${PGPASSWORD}")
        fi
    else
        # Prompt for connection details if not set via environment
        if [ -z "$PGHOST" ]; then
            read -p "Source host (default: localhost): " PGHOST
            PGHOST=${PGHOST:-localhost}
        fi

        if [ -z "$PGPORT" ]; then
            read -p "Source port (default: 5432): " PGPORT
            PGPORT=${PGPORT:-5432}
        fi
        log_info "Connecting to ${PGHOST}:${PGPORT} as ${PGUSER}"
    fi

    log_info "Exporting to: ${DUMP_FILE}"
    TMP_DUMP_FILE="${DUMP_FILE}.tmp"
    rm -f "${TMP_DUMP_FILE}"

    # Create the dump with pg_dump
    # -Fc = custom format (compressed, allows parallel restore)
    # Or use plain SQL with gzip for more compatibility
    if [ "${MODE}" = "docker" ]; then
        if docker exec "${DOCKER_ENV_ARGS[@]}" "${CONTAINER}" sh -lc \
            'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; exec pg_dump -U "$PGUSER" -d "$DB_NAME" --no-owner --no-acl --clean --if-exists' \
            | gzip > "${TMP_DUMP_FILE}"; then
            mv "${TMP_DUMP_FILE}" "${DUMP_FILE}"
            FILESIZE=$(du -h "${DUMP_FILE}" | cut -f1)
            log_info "Export completed successfully!"
            log_info "Dump file: ${DUMP_FILE} (${FILESIZE})"
            echo ""
            log_info "To transfer to another server, use:"
            echo "  scp ${DUMP_FILE} user@remote-server:/path/to/destination/"
        else
            rm -f "${TMP_DUMP_FILE}"
            log_error "Export failed!"
            exit 1
        fi
    elif PGPASSWORD="${PGPASSWORD}" pg_dump \
        -h "${PGHOST}" \
        -p "${PGPORT}" \
        -U "${PGUSER}" \
        -d "${DB_NAME}" \
        --no-owner \
        --no-acl \
        --clean \
        --if-exists \
        | gzip > "${TMP_DUMP_FILE}"; then
        mv "${TMP_DUMP_FILE}" "${DUMP_FILE}"
        FILESIZE=$(du -h "${DUMP_FILE}" | cut -f1)
        log_info "Export completed successfully!"
        log_info "Dump file: ${DUMP_FILE} (${FILESIZE})"
        echo ""
        log_info "To transfer to another server, use:"
        echo "  scp ${DUMP_FILE} user@remote-server:/path/to/destination/"
    else
        rm -f "${TMP_DUMP_FILE}"
        log_error "Export failed!"
        exit 1
    fi
}

# Import function
import_db() {
    local IMPORT_FILE="$1"
    local MODE="tcp"
    local CONTAINER="${PG_CONTAINER}"
    local -a DOCKER_ENV_ARGS=()

    if [ -z "${IMPORT_FILE}" ]; then
        log_error "Please provide a dump file to import"
        echo "Usage: $0 import <dump_file.sql.gz> [--docker] [--container <name>]"
        exit 1
    fi

    shift
    parse_mode_args MODE CONTAINER "$@"

    if [ ! -f "${IMPORT_FILE}" ]; then
        log_error "File not found: ${IMPORT_FILE}"
        exit 1
    fi

    log_info "Starting import from: ${IMPORT_FILE}"

    if [ -z "$PGUSER" ]; then
        read -p "Target username (default: postgres): " PGUSER
        PGUSER=${PGUSER:-postgres}
    fi

    if [ "${MODE}" = "docker" ]; then
        ensure_container_running "${CONTAINER}"
        log_info "Using Docker container: ${CONTAINER}"
        DOCKER_ENV_ARGS=(-e "PGUSER=${PGUSER}" -e "DB_NAME=${DB_NAME}")
        if [ -n "${PGPASSWORD}" ]; then
            DOCKER_ENV_ARGS+=(-e "PGPASSWORD=${PGPASSWORD}")
        fi
    else
        # Prompt for connection details if not set via environment
        if [ -z "$PGHOST" ]; then
            read -p "Target host (default: localhost): " PGHOST
            PGHOST=${PGHOST:-localhost}
        fi

        if [ -z "$PGPORT" ]; then
            read -p "Target port (default: 5432): " PGPORT
            PGPORT=${PGPORT:-5432}
        fi
        log_info "Connecting to ${PGHOST}:${PGPORT} as ${PGUSER}"
    fi

    # Check if database exists, create if not
    log_info "Checking if database exists..."

    if [ "${MODE}" = "docker" ]; then
        if docker exec "${DOCKER_ENV_ARGS[@]}" "${CONTAINER}" sh -lc \
            'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; psql -U "$PGUSER" -lqt' | cut -d \| -f 1 | grep -qw "${DB_NAME}"; then
            log_warn "Database ${DB_NAME} already exists"
            read -p "Drop and recreate? (y/N): " CONFIRM
            if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
                log_info "Dropping existing database..."
                docker exec "${DOCKER_ENV_ARGS[@]}" "${CONTAINER}" sh -lc \
                    'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";"'
            else
                log_info "Proceeding with import (will overwrite existing data)..."
            fi
        fi

        # Create database if it doesn't exist
        log_info "Creating database if not exists..."
        docker exec "${DOCKER_ENV_ARGS[@]}" "${CONTAINER}" sh -lc \
            'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; psql -U "$PGUSER" -d postgres -c "CREATE DATABASE \"${DB_NAME}\";"' \
            2>/dev/null || true
    else
        if psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -lqt | cut -d \| -f 1 | grep -qw "${DB_NAME}"; then
            log_warn "Database ${DB_NAME} already exists"
            read -p "Drop and recreate? (y/N): " CONFIRM
            if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
                log_info "Dropping existing database..."
                psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";"
            else
                log_info "Proceeding with import (will overwrite existing data)..."
            fi
        fi

        # Create database if it doesn't exist
        log_info "Creating database if not exists..."
        psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres -c "CREATE DATABASE \"${DB_NAME}\";" 2>/dev/null || true
    fi

    # Import the dump
    log_info "Importing data (this may take a while)..."

    if [ "${MODE}" = "docker" ]; then
        if [[ "${IMPORT_FILE}" == *.gz ]]; then
            if gunzip -c "${IMPORT_FILE}" | docker exec -i "${DOCKER_ENV_ARGS[@]}" "${CONTAINER}" sh -lc \
                'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; exec psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$DB_NAME"'; then
                log_info "Import completed successfully!"
            else
                log_error "Import failed!"
                exit 1
            fi
        else
            if docker exec -i "${DOCKER_ENV_ARGS[@]}" "${CONTAINER}" sh -lc \
                'export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"; exec psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$DB_NAME"' < "${IMPORT_FILE}"; then
                log_info "Import completed successfully!"
            else
                log_error "Import failed!"
                exit 1
            fi
        fi
    else
        if [[ "${IMPORT_FILE}" == *.gz ]]; then
            if gunzip -c "${IMPORT_FILE}" | psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${DB_NAME}"; then
                log_info "Import completed successfully!"
            else
                log_error "Import failed!"
                exit 1
            fi
        else
            if psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${DB_NAME}" < "${IMPORT_FILE}"; then
                log_info "Import completed successfully!"
            else
                log_error "Import failed!"
                exit 1
            fi
        fi
    fi
}

# Show usage
usage() {
    echo "PostgreSQL Database Migration Script"
    echo ""
    echo "Usage:"
    echo "  $0 export [--docker] [--container <name>] - Export database to a compressed SQL file"
    echo "  $0 import <file> [--docker] [--container <name>] - Import database from a SQL file"
    echo ""
    echo "Environment variables (optional):"
    echo "  PG_CONTAINER - Docker container name for --docker mode (default: sootio-postgres)"
    echo "  PGHOST    - Database host"
    echo "  PGPORT    - Database port"
    echo "  PGUSER    - Database username"
    echo "  PGPASSWORD - Database password (or use .pgpass file)"
    echo ""
    echo "Examples:"
    echo "  # Export from local database"
    echo "  $0 export"
    echo ""
    echo "  # Export from Docker Postgres container"
    echo "  $0 export --docker"
    echo ""
    echo "  # Export with custom connection"
    echo "  PGHOST=db.example.com PGUSER=admin $0 export"
    echo ""
    echo "  # Import to new server"
    echo "  PGHOST=newserver.com $0 import ./db_dumps/sootio-postgres_20240101_120000.sql.gz"
    echo ""
    echo "  # Import into Docker Postgres container"
    echo "  $0 import ./db_dumps/sootio_20240101_120000.sql.gz --docker"
}

# Main
case "${1}" in
    export)
        export_db "${@:2}"
        ;;
    import)
        import_db "$2" "${@:3}"
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        usage
        exit 1
        ;;
esac
