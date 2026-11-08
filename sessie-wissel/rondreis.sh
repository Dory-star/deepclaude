#!/bin/bash
# rondreis.sh - regressietest voor `wissel`: Anthropic -> BytePlus -> DeepClaude -> Anthropic -> BytePlus.
# Gebruikt nepbestanden in een wegwerpmap; elke stap leest een nieuw bestand (tool-aanroep) en moet
# alle codes uit eerdere stappen nog weten (het gesprek loopt dus echt door). Uitkomst per stap:
#   opened        de sessie is geopend en gaf antwoord zonder foutmelding
#   survived_turn het antwoord noemt alle eerdere codes (de geschiedenis is meegekomen)
#   survived_tool het nieuwe bestand is gelezen (een tool-aanroep werkte in het nieuwe model)
# Gebruik: rondreis.sh [--stappen "anthropic byteplus deepclaude anthropic byteplus"]
# Let op: dit gebruikt een paar echte modelaanroepen (Anthropic-abonnement, BytePlus-quotum, DeepSeek).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$HERE/wissel"
STAPPEN=(anthropic byteplus deepclaude anthropic byteplus)
if [ "${1:-}" = "--stappen" ]; then read -r -a STAPPEN <<< "${2:-}"; fi

T="$HOME/sessie-wissel-test/rondreis-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$T" && cd "$T" || exit 1
CODES=(kaasplank-11 appeltaart-22 druivenpudding-33 bananenbrood-44 citroentaart-55 perentaart-66)
for i in "${!STAPPEN[@]}"; do printf 'Code: %s\n' "${CODES[$i]}" > "bestand$((i+1)).txt"; done

# claude-uitvoer (JSON op een regel, eventueel tussen banners) -> session_id<TAB>is_error<TAB>result
parse() {
    python3 -I -c '
import sys,json
r=[l for l in sys.stdin.read().splitlines() if l.startswith("{")]
if not r: print("\t1\tgeen JSON-uitvoer"); sys.exit()
try:
    d=json.loads(r[-1]); print("%s\t%s\t%s"%(d.get("session_id",""),1 if d.get("is_error") else 0,(d.get("result") or "").replace("\n"," ").replace("\t"," ")))
except Exception as e: print("\t1\tonleesbare uitvoer")'
}

sid=""; falen=0
printf '%-4s %-11s %-8s %-14s %-14s %-14s\n' stap doel model opened survived_turn survived_tool
for i in "${!STAPPEN[@]}"; do
    n=$((i+1)); doel="${STAPPEN[$i]}"; nieuw="${CODES[$i]}"
    if [ $i -eq 0 ]; then vraag="Lees bestand1.txt en noem de code die erin staat."
    else vraag="Lees bestand${n}.txt en noem de code daarin. Noem daarna ook alle codes uit de eerdere bestanden die je in dit gesprek zag."; fi
    if [ $i -eq 0 ]; then
        uit="$(env -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
              claude -p --model sonnet --output-format json "$vraag" 2>/dev/null | parse)"
    else
        uit="$("$W" "$doel" --sessie "$sid" -- -p --output-format json "$vraag" 2>/dev/null | parse)"
    fi
    IFS=$'\t' read -r nsid fout antwoord <<< "$uit"
    o="ja"; t="nee"; g="nee"
    [ "$fout" != "0" ] && o="NEE"
    if [ "$o" = "ja" ]; then
        t="ja"; for ((j=0; j<i; j++)); do case "$antwoord" in *"${CODES[$j]}"*) ;; *) t="nee";; esac; done
        case "$antwoord" in *"$nieuw"*) g="ja";; esac
    fi
    printf '%-4s %-11s %-8s %-14s %-14s %-14s\n' "$n" "$doel" "-" "$o" "$t" "$g"
    if [ "$o" != "ja" ] || [ "$t" != "ja" ] || [ "$g" != "ja" ]; then
        falen=$((falen+1)); echo "     melding/antwoord: ${antwoord:0:200}"
    fi
    [ -n "$nsid" ] && sid="$nsid" || { echo "Geen sessie-id meer; stoppen."; break; }
done
echo "---"
[ $falen -eq 0 ] && echo "RONDREIS GESLAAGD (map: $T)" || echo "RONDREIS: $falen stap(pen) met problemen (map: $T)"
exit $falen
