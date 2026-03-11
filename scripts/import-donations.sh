#!/bin/bash
#
# Import donations.json into the Sootio Docker container
#
# Usage: ./scripts/import-donations.sh [source-directory-or-file]
#

set -euo pipefail

CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
SOURCE_INPUT="${1:-./donations-backup}"
TARGET_PATH="${DONATIONS_FILE_PATH:-/app/data/donations.json}"
BASENAME="$(basename "${TARGET_PATH}")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

resolve_source_file() {
    local input_path="$1"

    if [ -f "${input_path}" ]; then
        printf '%s\n' "${input_path}"
        return 0
    fi

    if [ -d "${input_path}" ]; then
        if [ -L "${input_path}/${BASENAME}.latest" ]; then
            readlink -f "${input_path}/${BASENAME}.latest"
            return 0
        fi

        if ls "${input_path}/${BASENAME}".* >/dev/null 2>&1; then
            ls -t "${input_path}/${BASENAME}".* | head -1
            return 0
        fi

        if [ -f "${input_path}/${BASENAME}" ]; then
            printf '%s\n' "${input_path}/${BASENAME}"
            return 0
        fi
    fi

    return 1
}

echo -e "${GREEN}=== Sootio Donation Data Import ===${NC}"
echo ""

if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}Error: docker is not installed or not in PATH${NC}"
    exit 1
fi

SOURCE_FILE="$(resolve_source_file "${SOURCE_INPUT}" || true)"
if [ -z "${SOURCE_FILE}" ] || [ ! -f "${SOURCE_FILE}" ]; then
    echo -e "${RED}Error: Could not find a donation backup in '${SOURCE_INPUT}'${NC}"
    exit 1
fi

if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "${SOURCE_FILE}"; then
    echo -e "${RED}Error: Source file is not valid JSON${NC}"
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}Warning: Container '${CONTAINER_NAME}' is not running${NC}"
    echo "Attempting to start container..."
    docker start "${CONTAINER_NAME}" >/dev/null || {
        echo -e "${RED}Failed to start container '${CONTAINER_NAME}'${NC}"
        exit 1
    }
    sleep 3
fi

echo -e "Container: ${YELLOW}${CONTAINER_NAME}${NC}"
echo -e "Source file: ${YELLOW}${SOURCE_FILE}${NC}"
echo -e "Target file: ${YELLOW}${TARGET_PATH}${NC}"
echo ""
echo -e "${YELLOW}WARNING: This will overwrite the donation data file in the container.${NC}"
read -p "Continue? (yes/no): " -r
echo ""
if [[ ! "${REPLY}" =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Import cancelled."
    exit 0
fi

TEMP_NAME="${BASENAME}.import.$(date +%s).$$"
TEMP_PATH="/tmp/${TEMP_NAME}"
BACKUP_PATH="${TARGET_PATH}.backup.$(date +%s)"

docker cp "${SOURCE_FILE}" "${CONTAINER_NAME}:${TEMP_PATH}"

if ! docker exec "${CONTAINER_NAME}" node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "${TEMP_PATH}"; then
    echo -e "${RED}Error: Imported temp file is not valid JSON inside the container${NC}"
    docker exec "${CONTAINER_NAME}" sh -c "rm -f '${TEMP_PATH}'" >/dev/null 2>&1 || true
    exit 1
fi

docker exec "${CONTAINER_NAME}" sh -c "
set -e
mkdir -p \"\$(dirname '${TARGET_PATH}')\"
if [ -f '${TARGET_PATH}' ]; then
    cp '${TARGET_PATH}' '${BACKUP_PATH}'
fi
mv '${TEMP_PATH}' '${TARGET_PATH}'
"

docker exec "${CONTAINER_NAME}" sh -c "chown 1000:1000 '${TARGET_PATH}'" >/dev/null 2>&1 || true

echo -e "${GREEN}✓ Imported donation data to ${TARGET_PATH}${NC}"
if docker exec "${CONTAINER_NAME}" test -f "${BACKUP_PATH}" 2>/dev/null; then
    echo -e "${GREEN}✓ Backup created: ${BACKUP_PATH}${NC}"
fi
