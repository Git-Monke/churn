#!/bin/sh
# Regenerate the location lists embedded in src/vpn.rs.
#
# The installer validates the country/region picker offline, so the lists are
# compiled in rather than fetched at install time. They come from the same
# Gluetun image the compose file pins, which is what makes them correct: a
# value Gluetun's server data does not contain is a value that would leave the
# tunnel without a server.
#
# Run this after bumping the Gluetun tag and review the diff, exactly like a
# dependency bump:
#
#   scripts/vpn-servers.sh          # print the Rust constants
#   scripts/vpn-servers.sh --write  # rewrite the constants in src/vpn.rs
#
# Gluetun's own docs warn that its built-in server data goes stale, so a
# location that disappears here is worth checking against the provider before
# deleting it.
set -eu

image=${GLUETUN_IMAGE:-qmcgaw/gluetun:v3.41.3}
root=$(cd "$(dirname "$0")/.." && pwd)
target="$root/src/vpn.rs"
write=0
[ "${1:-}" = "--write" ] && write=1

command -v docker >/dev/null 2>&1 || {
    echo "vpn-servers: docker is required to read Gluetun's server list" >&2
    exit 1
}

# provider:constant:filter-column
#
# The column is the one Gluetun's `format-servers` table puts the filter value
# in, which is not the same for every provider: PIA's `SERVER_REGIONS` values
# are in the Region column, while the others use Country.
providers='
mullvad:MULLVAD_LOCATIONS:2
ivpn:IVPN_LOCATIONS:2
protonvpn:PROTONVPN_LOCATIONS:2
nordvpn:NORDVPN_LOCATIONS:2
surfshark:SURFSHARK_LOCATIONS:3
private-internet-access:PIA_REGIONS:2
'

emit_const() {
    provider=$1
    constant=$2
    column=$3

    # Country/TLD names sort differently under a locale that folds case or
    # ignores spaces; Rust's Ord is byte-wise, so sort byte-wise and let the
    # unit test in src/vpn.rs prove it.
    docker run --rm "$image" format-servers "-$provider" 2>/dev/null |
        awk -F'|' -v column="$column" '
            NR > 2 && $column != "" {
                value = $column
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
                if (value != "") print value
            }
        ' |
        LC_ALL=C sort -u |
        awk -v constant="$constant" '
            BEGIN {
                print "#[rustfmt::skip]"
                print "const " constant ": &[&str] = &["
                line = "    "
            }
            {
                piece = "\"" $0 "\", "
                if (length(line) + length(piece) > 96) {
                    sub(/[[:space:]]+$/, "", line)
                    print line
                    line = "    "
                }
                line = line piece
            }
            END {
                if (length(line) > 4) {
                    sub(/[[:space:]]+$/, "", line)
                    print line
                }
                print "];"
            }
        '
}

rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
while IFS=: read -r provider constant column; do
    [ -n "${provider:-}" ] || continue
    {
        emit_const "$provider" "$constant" "$column"
        printf '\n'
    } >>"$rendered"
done <<EOF
$providers
EOF

if [ "$write" -eq 0 ]; then
    cat "$rendered"
    exit 0
fi

# Replace each constant block in place, leaving the doc comments above them and
# everything else in the module untouched.
python3 - "$target" "$rendered" <<'PY'
import re
import sys

target, rendered = sys.argv[1], sys.argv[2]
source = open(target).read()
blocks = open(rendered).read()

# Split the rendered output into {CONSTANT: "const CONSTANT: &[&str] = &[...];"}.
pattern = re.compile(
    r"#\[rustfmt::skip\]\nconst ([A-Z0-9_]+): &\[&str\] = &\[.*?\n\];", re.S
)
replacements = {match.group(1): match.group(0) for match in pattern.finditer(blocks)}
if not replacements:
    sys.exit("vpn-servers: no constants were rendered")

updated = source
missing = []
for name, block in replacements.items():
    existing = re.search(
        r"#\[rustfmt::skip\]\nconst " + name + r": &\[&str\] = &\[.*?\n\];",
        updated,
        re.S,
    )
    if not existing:
        missing.append(name)
        continue
    updated = updated[: existing.start()] + block + updated[existing.end():]

if missing:
    sys.exit(
        "vpn-servers: src/vpn.rs has no constant(s): " + ", ".join(sorted(missing))
    )
if updated == source:
    print("vpn-servers: no changes", file=sys.stderr)
else:
    open(target, "w").write(updated)
    print("vpn-servers: updated " + target, file=sys.stderr)
PY
