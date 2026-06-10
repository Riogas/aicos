#!/bin/bash
# AICOS ticket housekeeping.
#
# Marks two kinds of issues as hidden (Paperclip's hidden_at column) so they
# stop appearing in the dashboard / lists. We never DELETE rows — they stay
# for forensic history.
#
#   1) Test debris: issues with status in (done, cancelled, blocked) older
#      than DAYS_OLD whose title contains the word "test", "TEST", "fresh",
#      "FALLBACK", "BACKLOG", or "BLOCK-TEST" (markers our scripts use).
#   2) Stale done/cancelled: anything done/cancelled older than DAYS_OLD,
#      regardless of title.
#
# Defaults to dry-run (just shows what WOULD be hidden). Pass --apply to
# actually run the UPDATE.
#
# Usage:
#   bash scripts/cleanup_tickets.sh [--apply] [--days N]

set -e

DAYS_OLD=30
APPLY=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --apply) APPLY=1; shift ;;
    --days) DAYS_OLD=$2; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

COMPANY_ID="${AICOS_COMPANY_ID:-83ef9217-4f01-473b-a90f-5cc36152d03b}"

PSQL="docker exec aicos-postgres psql -U aicos -d paperclip -tA"

echo "=== Cleanup plan ($([ $APPLY -eq 1 ] && echo APPLY || echo DRY-RUN), days=$DAYS_OLD) ==="
echo

# 1. Test debris query
TEST_QUERY="
SELECT id, identifier, status, updated_at::date, substring(title, 1, 60)
FROM issues
WHERE company_id = '$COMPANY_ID'
  AND hidden_at IS NULL
  AND status IN ('done','cancelled','blocked')
  AND updated_at < now() - interval '$DAYS_OLD days'
  AND (
    title ~* 'test|fresh|fallback|backlog|block-test|fake-|e2e'
  )
ORDER BY updated_at;
"

echo "=== Test debris (candidates) ==="
$PSQL -c "$TEST_QUERY" | awk -F'|' 'NR>0 && NF>=4 { printf "  %-12s %-12s %-12s %s\n", $2, $3, $4, $5 }' | head -30
TEST_COUNT=$($PSQL -c "$TEST_QUERY" | wc -l)
echo "  total test debris: $TEST_COUNT"
echo

# 2. Stale done/cancelled query
STALE_QUERY="
SELECT id, identifier, status, updated_at::date, substring(title, 1, 60)
FROM issues
WHERE company_id = '$COMPANY_ID'
  AND hidden_at IS NULL
  AND status IN ('done','cancelled')
  AND updated_at < now() - interval '$DAYS_OLD days'
ORDER BY updated_at;
"

echo "=== Stale done/cancelled (>${DAYS_OLD}d) ==="
$PSQL -c "$STALE_QUERY" | awk -F'|' 'NR>0 && NF>=4 { printf "  %-12s %-12s %-12s %s\n", $2, $3, $4, $5 }' | head -30
STALE_COUNT=$($PSQL -c "$STALE_QUERY" | wc -l)
echo "  total stale done/cancelled: $STALE_COUNT"
echo

if [ $APPLY -eq 1 ]; then
  echo "=== Applying UPDATE hidden_at=now() ==="
  HIDE_TEST="UPDATE issues SET hidden_at=now()
    WHERE company_id = '$COMPANY_ID'
      AND hidden_at IS NULL
      AND status IN ('done','cancelled','blocked')
      AND updated_at < now() - interval '$DAYS_OLD days'
      AND title ~* 'test|fresh|fallback|backlog|block-test|fake-|e2e';"
  HIDE_STALE="UPDATE issues SET hidden_at=now()
    WHERE company_id = '$COMPANY_ID'
      AND hidden_at IS NULL
      AND status IN ('done','cancelled')
      AND updated_at < now() - interval '$DAYS_OLD days';"
  docker exec aicos-postgres psql -U aicos -d paperclip -c "BEGIN; $HIDE_TEST $HIDE_STALE COMMIT;" 2>&1 | tail -5
  echo
  echo "Visible (non-hidden) issue count after cleanup:"
  $PSQL -c "SELECT COUNT(*) FROM issues WHERE company_id='$COMPANY_ID' AND hidden_at IS NULL;"
else
  echo "(dry-run; pass --apply to actually hide them)"
fi
