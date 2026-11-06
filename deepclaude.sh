#!/usr/bin/env bash
# deepclaude — Use Claude Code with DeepSeek V4 Pro or other cheap backends
# Usage: deepclaude [--backend ds|smart|or|fw|anthropic] [--remote] [--status] [--cost] [--benchmark]
# Default (smart): one session, 4 models via /model — DeepSeek direct + OpenRouter.

set -euo pipefail

# Resolve symlinks: deepclaude staat op PATH als symlink in /usr/local/bin,
# zodat $SCRIPT_DIR naar de echte deepclaude-map wijst (proxy-bestanden).
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
    TARGET="$(readlink "$SOURCE")"
    [[ "$TARGET" != /* ]] && TARGET="$(dirname "$SOURCE")/$TARGET"
    SOURCE="$TARGET"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

# Keys fallback: mist de shell-omgeving een key (bijv. deepclaude gestart
# vanuit een app of een oude terminal), lees hem dan rechtstreeks uit
# ~/.zshrc — de enige bron van waarheid voor API-keys.
load_key() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        local v
        v=$(grep -E "^export ${name}=" "$HOME/.zshrc" 2>/dev/null | head -1 | sed -E 's/^export [A-Z_]+="(.*)"$/\1/') || true
        if [[ -n "$v" ]]; then export "$name=$v"; fi
    fi
}
load_key DEEPSEEK_API_KEY
load_key OPENROUTER_API_KEY
load_key FIREWORKS_API_KEY
load_key SUPABASE_ACCESS_TOKEN
# Zonder deze zag de GitHub-MCP-plugin een lege Bearer-token onder DeepClaude
# (de plugin gebruikt ${GITHUB_PERSONAL_ACCESS_TOKEN}, geen claude.ai-auth).
load_key GITHUB_PERSONAL_ACCESS_TOKEN

# --- Config ---
DEEPSEEK_URL="https://api.deepseek.com/anthropic"
OPENROUTER_URL="https://openrouter.ai/api"
FIREWORKS_URL="https://api.fireworks.ai/inference"

BACKEND="${CHEAPCLAUDE_DEFAULT_BACKEND:-smart}"
ACTION="launch"
SWITCH_BACKEND=""
PROXY_PID=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --switch|-s)  ACTION="switch"; SWITCH_BACKEND="$2"; shift 2 ;;
        --remote|-r)  ACTION="remote"; shift ;;
        --status)     ACTION="status"; shift ;;
        --cost)       ACTION="cost"; shift ;;
        --keys)       ACTION="keys"; shift ;;
        --benchmark)  ACTION="benchmark"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        *)            break ;;
    esac
done

cleanup_proxy() {
    if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
        kill "$PROXY_PID" 2>/dev/null || true
        echo "  Proxy stopped."
    fi
}
trap cleanup_proxy EXIT

mask_key() {
    local k="$1"
    if [[ -z "$k" ]]; then echo "MISSING"; else echo "set (****${k: -4})"; fi
}

resolve_backend() {
    local url="" key="" opus="" sonnet="" haiku="" subagent="" fable=""
    case "$BACKEND" in
        smart|all)
            key="${DEEPSEEK_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DEEPSEEK_API_KEY not set" >&2; exit 1; }
            url="$DEEPSEEK_URL"
            # 'smart'-slots = de rijen in /model (volledige uitleg: MODELS.md).
            #   10 sep 2026: het Flash-model heet officieel `deepseek-flash` en
            #   draait V4.1-Flash; `deepseek-v4-flash` is alleen nog een
            #   legacy-alias naar hetzelfde model. De bèta-naam
            #   (deepseek-v4.1-flash-expires-on-0910) is vervallen.
            #   10 sep 2026: de Opus-rij stond op `deepseek-v4-pro`. Die is
            #   hier bewust weggehaald. Reden: een hervatte sessie kon op de
            #   Opus-rij belanden en dan urenlang ongemerkt op het dure model
            #   draaien — 7 uur pro = ~$9 tegen ~$1,45 op flash. Flash scoort
            #   inmiddels beter dan Pro op alle vlakken, en vanaf 14 sep 2026
            #   routeert DeepSeek v4-pro-requests sowieso naar V4.1 Flash.
            #   Daarom wijzen ALLE rijen naar flash: één model, geen valkuil.
            # 7 okt 2026 — OPUS = MISTRAL LARGE 4 (Le Chonk, publieke API-preview).
            #   Bewust gekozen keuze-model voor reviewwerk/tweede mening; GEEN
            #   [1m]-suffix (512K-context, Anthropic-route niet nodig). De rest
            #   blijft DeepSeek Flash; Fable blijft GLM 5.2 (OpenRouter).
            #   Terugdraaien = deze regel weer op deepseek-flash zetten.
            opus="mistral-large-4"; sonnet="deepseek-flash"
            # 29 sep 2026 — OPTIE C: gesplitst.
            #   haiku  = achtergrondtaken (websearch, titels) → DeepSeek. Was GLM 5.2
            #            via OpenRouter: ~8000 onzichtbare verzoeken = $50 in 24 dagen.
            #   fable  = bewust kiesbaar via /model voor REVIEWWERK (andere ogen).
            #            Alleen als je hem zelf aanzet, dus de kosten zijn zichtbaar.
            haiku="deepseek-flash"
            fable="z-ai/glm-5.2"
            subagent="deepseek-flash"   # zelfde model als de default-rij
            ;;
        ds|deepseek)
            key="${DEEPSEEK_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DEEPSEEK_API_KEY not set" >&2; exit 1; }
            url="$DEEPSEEK_URL"
            opus="deepseek-flash"; sonnet="deepseek-flash"
            haiku="deepseek-flash"; subagent="deepseek-flash"
            fable="deepseek-flash"
            ;;
        or|openrouter)
            key="${OPENROUTER_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENROUTER_API_KEY not set" >&2; exit 1; }
            url="$OPENROUTER_URL"
            # or-route: main = GLM 5.2, second = Kimi K2.6 (pick via /model),
            # subagents = DeepSeek Flash (same model as ds-route),
            # small/background tasks = GLM 5.3 Flash (cheapest).
            opus="moonshotai/kimi-k2.6"; sonnet="z-ai/glm-5.2"
            haiku="z-ai/glm-5.3-flash"; subagent="deepseek/deepseek-v4-flash"
            fable="z-ai/glm-5.3-flash"
            ;;
        fw|fireworks)
            key="${FIREWORKS_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: FIREWORKS_API_KEY not set" >&2; exit 1; }
            url="$FIREWORKS_URL"
            opus="accounts/fireworks/models/deepseek-v4-pro"
            sonnet="accounts/fireworks/models/deepseek-v4-pro"
            haiku="accounts/fireworks/models/deepseek-v4-pro"
            subagent="accounts/fireworks/models/deepseek-v4-pro"
            fable="accounts/fireworks/models/deepseek-v4-pro"
            ;;
        anthropic) ;;
        *) echo "ERROR: Unknown backend '$BACKEND'. Use: smart, ds, or, fw, anthropic" >&2; exit 1 ;;
    esac
    RESOLVED_URL="$url"; RESOLVED_KEY="$key"
    RESOLVED_OPUS="$opus"; RESOLVED_SONNET="$sonnet"
    RESOLVED_HAIKU="$haiku"; RESOLVED_SUBAGENT="$subagent"; RESOLVED_FABLE="$fable"
}

set_model_env() {
    # $1 = model dat de Default-rij moet draaien (ANTHROPIC_MODEL), of "" voor
    # geen override (ds/or/fw: dan geldt gewoon de sonnet-slot).
    # DeepSeek-slots krijgen het "[1m]"-suffix: Claude Code gelooft dan een
    # 1M-context (geen auto-compact op 200k) en stuurt de bèta-header
    # context-1m-2025-08-07 mee; de dispatch-proxy en de CLI zelf strippen het
    # suffix vóór de wire. GLM/Kimi (128-256k) krijgen GEEN suffix.
    # Zet hier GEEN CLAUDE_CODE_MAX_CONTEXT_TOKENS: dat werkt alleen samen met
    # DISABLE_COMPACT én zou GLM/Kimi (verkeerd) óók raken.
    local m
    m="$RESOLVED_OPUS"
    if [[ "$m" == deepseek-* || "$m" == deepseek/deepseek-* ]]; then m="${m}[1m]"; fi
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$m"
    m="$RESOLVED_SONNET"
    if [[ "$m" == deepseek-* || "$m" == deepseek/deepseek-* ]]; then m="${m}[1m]"; fi
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$m"
    m="$RESOLVED_SUBAGENT"
    if [[ "$m" == deepseek-* || "$m" == deepseek/deepseek-* ]]; then m="${m}[1m]"; fi
    export CLAUDE_CODE_SUBAGENT_MODEL="$m"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$RESOLVED_HAIKU"
    export ANTHROPIC_DEFAULT_FABLE_MODEL="$RESOLVED_FABLE"
    # Effort wordt niet meer geforceerd. Eerder stond hier:
    #   export CLAUDE_CODE_EFFORT_LEVEL="max"
    # Dat overrulete /effort en settings.json in elke DeepClaude-sessie.
    # Niveau komt nu uit settings.json (modelSettings) en is per sessie
    # aanpasbaar met /effort. Wil je toch forceren: export de var zelf.
    if [[ -n "${1:-}" ]]; then
        export ANTHROPIC_MODEL="$1"
    else
        unset ANTHROPIC_MODEL
    fi
}

show_status() {
    echo ""
    echo "  deepclaude — Backend Status"
    echo "  ============================"
    echo ""
    echo "  Keys:"
    echo "    DEEPSEEK_API_KEY:    $(mask_key "${DEEPSEEK_API_KEY:-}")"
    echo "    OPENROUTER_API_KEY:  $(mask_key "${OPENROUTER_API_KEY:-}")"
    echo "    FIREWORKS_API_KEY:   $(mask_key "${FIREWORKS_API_KEY:-}")"
    echo ""
    echo "  Backends:"
    echo "    deepclaude                  # SMART: Default=flash (V4.1), Opus=pro, Sonnet=flash, Fable=Kimi, Haiku=GLM (zie MODELS.md)"
    echo "    deepclaude -b ds            # DeepSeek direct (geen proxy)"
    echo "    deepclaude -b or            # OpenRouter: GLM 5.2 + Kimi K2.6"
    echo "    deepclaude -b fw            # Fireworks AI (fastest)"
    echo "    deepclaude -b anthropic     # Normal Claude Code"
    echo "    deepclaude --remote         # Remote control + DeepSeek"
    echo "    deepclaude --remote -b or   # Remote control + OpenRouter"
    echo ""
    local proxy_status
    proxy_status=$(curl -s http://127.0.0.1:3200/_proxy/status 2>/dev/null) || proxy_status=""
    if [[ -n "$proxy_status" ]]; then
        echo "  Proxy: running"
        echo "    $proxy_status"
    else
        echo "  Proxy: not running"
    fi
    echo ""
}

key_masked() {
    local v="$1"
    if [[ -z "$v" ]]; then echo "—"; else echo "…${v: -4}"; fi
}

key_live() {  # echo HTTP-status van een proefaanroep met de key (toont de key nooit)
    local prov="$1" key="$2" code
    case "$prov" in
        deepseek)   code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://api.deepseek.com/user/balance" -H "Authorization: Bearer $key") ;;
        openrouter) code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://openrouter.ai/api/v1/auth/key" -H "Authorization: Bearer $key") ;;
        fireworks)  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://api.fireworks.ai/inference/v1/models" -H "Authorization: Bearer $key") ;;
        *) code="?" ;;
    esac
    echo "$code"
}

show_keys() {
    echo ""
    echo "  API-key diagnose"
    echo "  ================="
    echo "  Bron: ~/.zshrc (regels 'export *_API_KEY=\"...\"')"
    echo "  Toont nooit de volledige key — alleen of alles klopt."
    echo ""
    for entry in "DEEPSEEK_API_KEY|deepseek" "OPENROUTER_API_KEY|openrouter" "FIREWORKS_API_KEY|fireworks"; do
        local name="${entry%%|*}" prov="${entry##*|}"
        local zshrc_val shell_val
        zshrc_val=$(grep -E "^export ${name}=" "$HOME/.zshrc" 2>/dev/null | head -1 | sed -E 's/^export [A-Z_]+="(.*)"$/\1/') || true
        shell_val="${!name:-}"

        local waar staat live
        if [[ -n "$zshrc_val" ]]; then
            waar=".zshrc: $(key_masked "$zshrc_val")"
        else
            waar=".zshrc: NIET aanwezig"
        fi
        if [[ -n "$shell_val" && -n "$zshrc_val" && "$shell_val" == "$zshrc_val" ]]; then
            staat="OK"
        elif [[ -n "$shell_val" && -n "$zshrc_val" ]]; then
            staat="VERSCHIL (shell $(key_masked "$shell_val")) — open nieuwe terminal of: source ~/.zshrc"
        elif [[ -n "$zshrc_val" ]]; then
            staat="niet in deze shell geladen (deepclaude laadt hem zelf)"
        else
            staat="niet gevonden"
        fi

        local testkey="${shell_val:-$zshrc_val}"
        if [[ -n "$testkey" ]]; then
            local code
            code=$(key_live "$prov" "$testkey")
            if [[ "$code" == "200" ]]; then live="werkt (proefaanroep OK)"
            elif [[ "$code" == "401" || "$code" == "403" ]]; then live="GEWEIGERD (code $code) — key ongeldig of ingetrokken"
            else live="onbereikbaar (code $code) — internet/proxy?"; fi
        else
            live="geen key om te testen"
        fi

        printf "  %-22s %s\n" "$name" "$staat"
        printf "  %-22s %s\n" "" "bestand: $waar"
        printf "  %-22s %s\n" "" "live:    $live"
        echo ""
    done
}

show_cost() {
    echo ""
    echo "  DeepSeek V4 Pro Pricing"
    echo "  ======================="
    echo ""
    echo "  Provider        Input/M    Output/M   Cache Hit/M"
    echo "  ----------      --------   --------   -----------"
    echo "  DeepSeek        \$0.44      \$0.87      \$0.004"
    echo "  OpenRouter      \$0.44      \$0.87      (provider)"
    echo "  Fireworks       \$1.74      \$3.48      (provider)"
    echo "  Anthropic       \$3.00      \$15.00     \$0.30"
    echo ""
    echo "  Monthly estimate (heavy use, 25 days): \$30-80"
    echo ""
}

show_help() {
    echo "deepclaude — Claude Code with cheap backends"
    echo ""
    echo "Usage: deepclaude [options] [-- claude-args...]"
    echo ""
    echo "Options:"
    echo "  -b, --backend <smart|ds|or|fw|anthropic>  Backend (default: smart)"
    echo "  -r, --remote                        Remote control mode (browser URL)"
    echo "  --status                             Show keys and backends"
    echo "  --keys                               Key diagnose (waar staat welke key, werkt hij?)"
    echo "  --cost                               Pricing comparison"
    echo "  --benchmark                          Latency test"
    echo "  -s, --switch <backend>               Switch proxy mid-session"
    echo "  -h, --help                           This help"
    echo ""
    echo "Backends:"
    echo "  smart     One session, 5 rijen via /model (default): Default-rij draait"
    echo "            deepseek-flash[1m] (= V4.1 Flash); Opus=deepseek-flash[1m]"
    echo "            (alle rijen flash sinds 10 sep 2026 — Pro is vervallen);"
    echo "            Fable=moonshotai/kimi-k2.6; Haiku=z-ai/glm-5.2 (zie MODELS.md)"
    echo "            DeepSeek calls stay direct; GLM/Kimi go via OpenRouter."
    echo "  ds        DeepSeek direct (single backend, no proxy)"
    echo "  or        OpenRouter: GLM 5.2 main + Kimi K2.6"
    echo "  fw        Fireworks AI (fastest)"
    echo "  anthropic Normal Claude Code"
    echo ""
    echo "Environment variables:"
    echo "  DEEPSEEK_API_KEY      DeepSeek API key (required for ds/smart)"
    echo "  OPENROUTER_API_KEY    OpenRouter API key (required for or; enables GLM/Kimi rows in smart)"
    echo "  FIREWORKS_API_KEY     Fireworks API key (required for fw)"
    echo "  CHEAPCLAUDE_DEFAULT_BACKEND  Default backend (default: smart)"
}

do_switch() {
    local backend="$SWITCH_BACKEND"
    case "$backend" in
        ds|deepseek)   backend="deepseek" ;;
        or|openrouter) backend="openrouter" ;;
        fw|fireworks)  backend="fireworks" ;;
        anthropic)     backend="anthropic" ;;
        *) echo "ERROR: Unknown backend '$backend'. Use: ds, or, fw, anthropic" >&2; exit 1 ;;
    esac
    local resp
    resp=$(curl -sX POST http://127.0.0.1:3200/_proxy/mode -d "backend=$backend" 2>/dev/null) || {
        echo "  Proxy not running. Start with: deepclaude" >&2; exit 1
    }
    echo "  $resp"
}

run_benchmark() {
    echo ""
    echo "  Latency Benchmark (1 request each)"
    echo "  ==================================="
    for name in deepseek openrouter fireworks; do
        local url="" key="" model=""
        case "$name" in
            deepseek)   url="$DEEPSEEK_URL"; key="${DEEPSEEK_API_KEY:-}"; model="deepseek-flash" ;;
            openrouter) url="$OPENROUTER_URL"; key="${OPENROUTER_API_KEY:-}"; model="deepseek/deepseek-v4-flash" ;;
            fireworks)  url="$FIREWORKS_URL"; key="${FIREWORKS_API_KEY:-}"; model="accounts/fireworks/models/deepseek-v4-pro" ;;
        esac
        if [[ -z "$key" ]]; then echo "  $name: SKIP (no key)"; continue; fi
        local start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url/v1/messages" \
            -H "x-api-key: $key" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
            -d "{\"model\":\"$model\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply: ok\"}]}" \
            --max-time 30 2>/dev/null || echo "timeout")
        local end_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local elapsed=$((end_ms - start_ms))
        if [[ "$status" == "200" ]]; then
            echo "  $name: OK (${elapsed}ms)"
        else
            echo "  $name: FAIL ($status, ${elapsed}ms)"
        fi
    done
    echo ""
}

launch_claude() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        echo "  Launching Claude Code (normal Anthropic backend)..."
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
        unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        unset CLAUDE_CODE_EFFORT_LEVEL
        exec claude "$@"
    fi

    resolve_backend

    echo "  Launching Claude Code via $BACKEND..."
    echo "  Endpoint: $RESOLVED_URL"
    echo "  Model: $RESOLVED_SONNET (main) | via /model: $RESOLVED_OPUS | subagents: $RESOLVED_SUBAGENT"
    echo ""

    # Sinds 6 nov 2026 loopt ook deze route via een proxy (eigen instantie,
    # eigen poort), niet meer rechtstreeks naar RESOLVED_URL.
    # Aanleiding: sessie "Google drive backup op server" (gestart met
    # `deepclaude --backend ds`) kreeg bij elk bericht
    #   422 … messages[1].content: unknown variant `tool_definition`,
    #   expected `tool_reference`
    # Claude Code stuurt tools van claude.ai-connectors (bv.
    # mcp__claude_ai_Claude_Docs__*) als inline tool_addition/tool_definition-
    # blok; DeepSeek kent alleen de tool_reference-variant. De fix daarvoor
    # (sanitizeInlineToolBlocks in proxy/model-proxy.js) zat wél in de
    # smart-proxy, maar deze directe route ging er langsheen. Bewezen met het
    # echte payload uit dat transcript: 3 tool_definition-blokken → 0.
    local proxy_backend
    case "$BACKEND" in
        ds|deepseek)   proxy_backend="deepseek" ;;
        or|openrouter) proxy_backend="openrouter" ;;
        fw|fireworks)  proxy_backend="fireworks" ;;
        *)             proxy_backend="$BACKEND" ;;
    esac
    echo "  Starting model proxy for $proxy_backend..."

    # Standalone modus (--mode/--port-file): die schrijft de poort exact in het
    # port-file; de legacy-vorm (url+key als positionals) zet de poort op stdout
    # tussen de logregels, waardoor `head -1` de logregel als poort pakte.
    local port_file
    port_file=$(mktemp)
    node "$SCRIPT_DIR/proxy/start-proxy.js" --mode "$proxy_backend" --port-file "$port_file" \
        >> /tmp/deepclaude-proxy.log 2>&1 &
    PROXY_PID=$!

    local tries=0
    while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
        sleep 0.2
        tries=$((tries + 1))
    done

    if [[ ! -s "$port_file" ]]; then
        echo "ERROR: Proxy failed to start" >&2
        rm -f "$port_file"
        exit 1
    fi

    local proxy_port
    proxy_port=$(cat "$port_file")
    rm -f "$port_file"

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    set_model_env ""   # geen ANTHROPIC_MODEL-override: sonnet-slot is de default
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

    # Geen exec: de EXIT-trap moet deze proxy opruimen als de sessie stopt.
    claude "$@"
}

launch_remote() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        echo "  Launching remote control (Anthropic)..."
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
        unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        unset CLAUDE_CODE_EFFORT_LEVEL ANTHROPIC_API_KEY
        exec claude remote-control "$@"
    fi

    resolve_backend

    # Zelfde opzet als launch_claude: standalone modus met --mode/--port-file
    # schrijft de poort exact weg. De oude legacy-vorm zette de poort op stdout
    # tussen de logregels, waardoor `head -1` de logregel als poort las en
    # ANTHROPIC_BASE_URL onbruikbaar werd. Zie ook de guard in start-proxy.js.
    local proxy_backend
    case "$BACKEND" in
        ds|deepseek)   proxy_backend="deepseek" ;;
        or|openrouter) proxy_backend="openrouter" ;;
        fw|fireworks)  proxy_backend="fireworks" ;;
        *)             proxy_backend="$BACKEND" ;;
    esac
    echo "  Starting model proxy for $proxy_backend..."

    local port_file
    port_file=$(mktemp)
    node "$SCRIPT_DIR/proxy/start-proxy.js" --mode "$proxy_backend" --port-file "$port_file" \
        >> /tmp/deepclaude-proxy.log 2>&1 &
    PROXY_PID=$!

    local tries=0
    while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
        sleep 0.2
        tries=$((tries + 1))
    done

    if [[ ! -s "$port_file" ]]; then
        echo "ERROR: Proxy failed to start" >&2
        rm -f "$port_file"
        exit 1
    fi

    local proxy_port
    proxy_port=$(head -1 "$port_file")
    rm -f "$port_file"

    echo "  Proxy on :$proxy_port -> $RESOLVED_URL"
    echo "  Launching remote control via $BACKEND..."
    echo ""

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    set_model_env ""   # geen ANTHROPIC_MODEL-override: sonnet-slot is de default
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

    claude remote-control "$@"
}

launch_smart() {
    resolve_backend   # 'smart' slots: Default=flash, Opus=pro, Sonnet=flash, Fable=Kimi, Haiku=GLM

    echo "  Launching Claude Code via smart proxy (5 /model-rijen)..."
    echo "  Default-rij: deepseek-v4-flash[1m] (via ANTHROPIC_MODEL, zie MODELS.md)"
    echo "  /model-slots: $RESOLVED_SONNET | $RESOLVED_OPUS | $RESOLVED_HAIKU | $RESOLVED_FABLE"
    echo "  subagents: $RESOLVED_SUBAGENT"
    if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
        echo "  NOTE: OPENROUTER_API_KEY not set — GLM/Kimi rows disabled (ds only)"
    fi
    echo ""

    # Dispatch proxy: routes each /v1/messages by model name —
    # deepseek-v4-* → DeepSeek direct, z-ai/* & moonshotai/* → OpenRouter.
    # Dit is een GEDEELDE proxy op een vast poortnummer: meerdere deepclaude
    # smart-sessies (verschillende terminals/projecten) draaien er tegelijk
    # tegenaan. Daarom nooit blind killen+herstarten hier — dat trekt de
    # proxy onder elke andere lopende sessie vandaan. Eerst checken of er al
    # een gezonde proxy luistert en die dan hergebruiken.
    local proxy_port=3200
    local proxy_status
    proxy_status=$(curl -s --max-time 1 "http://127.0.0.1:${proxy_port}/_proxy/status" 2>/dev/null) || proxy_status=""

    if [[ -n "$proxy_status" ]]; then
        echo "  Proxy on :$proxy_port (per-model dispatch) — hergebruikt, al actief"
    else
        # Geen (gezonde) proxy gevonden: ruim een eventuele hangende/dode
        # instantie op en start een nieuwe.
        pkill -f "start-proxy.js --dispatch" 2>/dev/null || true

        local port_file
        port_file=$(mktemp)
        node "$SCRIPT_DIR/proxy/start-proxy.js" --dispatch --port-file "$port_file" >> /tmp/deepclaude-proxy.log 2>&1 &
        disown

        local tries=0
        while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
            sleep 0.2
            tries=$((tries + 1))
        done

        if [[ ! -s "$port_file" ]]; then
            echo "ERROR: Proxy failed to start (log: /tmp/deepclaude-proxy.log)" >&2
            rm -f "$port_file"
            exit 1
        fi

        proxy_port=$(head -1 "$port_file")
        rm -f "$port_file"

        echo "  Proxy on :$proxy_port (per-model dispatch) — nieuw gestart"
    fi
    echo ""

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
    # Vangnet (7 okt 2026): experimentele Claude-API-bèta's uitzetten voor
    # third-party backends. Aanleiding: bèta `inline-tools-2026-09-15` —
    # Claude Code stuurde tool_definition-blokken die DeepSeek niet kent,
    # waardoor ELK bericht in zo'n sessie 422'de (sessie "Data facturen en
    # offertes"). De primaire fix zit in de proxy (sanitizeInlineToolBlocks
    # in model-proxy.js) en staat altijd aan; dit is het achtervang-net voor
    # toekomstige bèta's die de proxy nog niet kent.
    # LET OP bij aanzetten: dit zet óók MCP-tool-search uit — alle MCP-tools
    # laden dan upfront in elk verzoek (meer tokens/kosten per request).
    # Alleen aanzetten als de proxy-patch iets mist:
    #   export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
    # Default-rij = flash (1M-context). Sinds 10 sep 2026 heet dat model
    # officieel `deepseek-flash` (V4.1 Flash); de oude naam werkt nog als
    # legacy-alias. ANTHROPIC_MODEL wint bij opstart óók van een
    # settings.json-"model"-pin (bewezen in matrix-test E, 2026-09-08).
    set_model_env "deepseek-flash[1m]"
    unset ANTHROPIC_API_KEY

    # Geen PROXY_PID gezet: de EXIT trap stopt deze gedeelde proxy bewust
    # NIET meer bij het afsluiten van één sessie — andere sessies kunnen 'm
    # nog gebruiken. Herstart handmatig via dc() of:
    #   pkill -f "start-proxy.js --dispatch"
    claude "$@"
}

# --- Main ---
case "$ACTION" in
    status)    show_status ;;
    keys)      show_keys ;;
    cost)      show_cost ;;
    benchmark) run_benchmark ;;
    help)      show_help ;;
    switch)    do_switch ;;
    remote)    [[ "$BACKEND" == "smart" || "$BACKEND" == "all" ]] && BACKEND="ds"; launch_remote "$@" ;;
    launch)    if [[ "$BACKEND" == "smart" || "$BACKEND" == "all" ]]; then
                   launch_smart "$@"
               else
                   launch_claude "$@"
               fi ;;
esac
