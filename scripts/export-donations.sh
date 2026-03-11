#!/bin/bash
#
# Export donations.json from the Sootio Docker container
#
# Usage: ./scripts/export-donations.sh [output-directory]
#

set -euo pipefail

CONTAINER_NAME="${SOOTIO_CONTAINER:-sootio}"
OUTPUT_DIR="${1:-./donations-backup}"
SOURCE_PATH="${DONATIONS_FILE_PATH:-/app/data/donations.json}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BASENAME="$(basename "${SOURCE_PATH}")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Sootio Donation Data Export ===${NC}"
echo ""

if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}Error: docker is not installed or not in PATH${NC}"
    exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}Error: Container '${CONTAINER_NAME}' is not running${NC}"
    echo "Available containers:"
    docker ps --format "  - {{.Names}}"
    exit 1
fi

if ! docker exec "${CONTAINER_NAME}" test -f "${SOURCE_PATH}" 2>/dev/null; then
    echo -e "${RED}Error: Donation data file not found at ${SOURCE_PATH}${NC}"
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"
TARGET_FILE="${OUTPUT_DIR}/${BASENAME}.${TIMESTAMP}"

echo -e "Container: ${YELLOW}${CONTAINER_NAME}${NC}"
echo -e "Source file: ${YELLOW}${SOURCE_PATH}${NC}"
echo -e "Output directory: ${YELLOW}${OUTPUT_DIR}${NC}"
echo ""

docker cp "${CONTAINER_NAME}:${SOURCE_PATH}" "${TARGET_FILE}"

if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "${TARGET_FILE}"; then
    echo -e "${RED}Error: Exported file is not valid JSON${NC}"
    rm -f "${TARGET_FILE}"
    exit 1
fi

ln -sf "${BASENAME}.${TIMESTAMP}" "${OUTPUT_DIR}/${BASENAME}.latest"

SIZE="$(du -h "${TARGET_FILE}" | cut -f1)"
echo -e "${GREEN}✓ Exported: ${TARGET_FILE} (${SIZE})${NC}"
echo -e "${GREEN}✓ Latest symlink: ${OUTPUT_DIR}/${BASENAME}.latest${NC}"
