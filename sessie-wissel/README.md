# sessie-wissel: een Claude Code-sessie doorzetten naar een ander model

Gebouwd 9 november 2026. Achtergrond, aannames en reviews: `~/sessie-wisselen-plan.md`.

## Gebruik

Stop de oude sessie (Ctrl+C / `/exit`), blijf in dezelfde projectmap, en typ:

```
wissel anthropic            # terug naar het Anthropic-abonnement (model standaard sonnet)
wissel deepclaude           # DeepClaude, smart-modus via de proxy
wissel byteplus             # BytePlus Coding Plan, geen proxy (standaard dola-seed-2.0-pro)
wissel byteplus glm-5.2     # ander model op hetzelfde doel
wissel anthropic opus --sessie <id>   # een bepaalde sessie in plaats van de nieuwste
```

Interactief toont Claude Code zijn eigen keuzescherm (zoals `/resume`) voor de huidige map, zodat je zelf
de juiste sessie kiest; dat het scherm samen met `--fork-session` werkt is volgens `claude --help`
bedoeld maar **niet in een echte terminal door mij geprobeerd**. Wil je liever de nieuwste sessie, gebruik
`--nieuwste` (de titel staat dan in de melding, zodat je kunt zien of het de goede is). Headless
(`-- -p ...`) kiest altijd de nieuwste. Hervat wordt met `--resume --fork-session`: je krijgt een nieuw
sessie-id en de oorspronkelijke sessie blijft onaangetast. Het Anthropic-model is je eigen `model` uit
`~/.claude/settings.json` (nu `sonnet`), anders sonnet. Het script zet ook het juiste model en de
juiste omgeving. Dat laatste is belangrijk: een sessie onthoudt het model van de vorige keer, en
Anthropic antwoordt dan "issue with the selected model (deepseek-flash[1m])".

`wissel` staat als symlink in `/usr/local/bin/wissel`.

**Vanuit een lopende sessie:** `/wissel byteplus` (slash-command in `~/.claude/commands/wissel.md`, staat
buiten de repo). Een lopend proces kan zijn aanbieder niet meer wisselen (adres en sleutel liggen bij het
starten vast; `/model` wisselt alleen binnen dezelfde aanbieder), dus dit opent een **nieuw Terminal-venster**
met een kopie van precies déze sessie (via `CLAUDE_CODE_SESSION_ID`) en je sluit de oude met `/exit`.
Technisch: `wissel <doel> --venster`. `WISSEL_DROOG=1` toont alleen het commando.

## Wat we gemeten hebben (9 nov 2026, Claude Code 2.1.319)

- Een **ruwe hervatting** (zonder iets te filteren) werkt in elke richting: Anthropic, DeepSeek via de
  proxy en BytePlus, ook met denkblokken, een open tool-aanroep aan het eind en een tool-zoekopdracht in
  de geschiedenis. Claude Code herstelt een open `tool_use` zelf.
- Wat er in de praktijk misging (catalogus uit 1.000+ oude sessies): `tool_definition`/`tool_removal` 422
  (de proxy vangt dat op), **modelnaam uit de oude sessie niet geldig bij Anthropic** (hier opgelost met
  expliciet `--model`), een te lange sessie (1M-context overschreden), en tool-schema's (`\0`-patroon).
  Denkblokken of handtekeningen zijn in geen enkele echte fout de oorzaak geweest.
- `rondreis.sh` doet de hele reeks Anthropic -> BytePlus -> DeepClaude -> Anthropic -> BytePlus met in elke
  stap een nieuwe tool-aanroep en controle dat de eerdere codes nog bekend zijn: 5 van 5 geslaagd.

## Onderdelen

| Bestand | Wat |
|---|---|
| `wissel` | de launcher; schrijft een regel (geen inhoud) naar `wissels.log` |
| `rondreis.sh` | regressietest met een paar echte modelaanroepen; draai na een Claude Code-update |
| `schoon.py` | **noodoptie** (`wissel ... --schoon`): maakt een opgeschoonde kopie (denkblokken, tool-blokken en `api-request*` weg, `parentUuid`-keten hersteld, open `tool_use` afgesloten). Standaard niet nodig. |
| `test_schoon.py` | 10 unit-tests met een nep-sessie; mutatietests: keten-herstel en afsluiten van open tool_use worden door de tests opgemerkt |

## Beperkingen en nog open

- **Te lange sessies.** Doubao heeft 256K context; een sessie van 600K past niet (BytePlus), en bij
  DeepSeek/GLM bestaat een limiet van 1M. Nog niet opgelost (Fase 5: oude tool-resultaten inkorten).
- Alleen kleine, nep-sessies getest; echte, lange sessies kunnen nog uitvallen. Het logboek `wissels.log`
  noteert elke wissel met leeftijd en aantal regels, zodat we zien waar het mis begint te gaan.
- Het BytePlus Coding Plan mag alleen in coding-tools. `wissel byteplus` start Claude Code rechtstreeks
  (geen proxy ertussen). Automatisch verlengen van het abonnement staat nog aan tot Dorus het uitzet.
- OpenAI/Codex valt buiten deze versie.
