# Modellen veranderen in deepclaude — het complete recept

Dit document is hét antwoord op: "hoe verander ik de modellen?" Zowel de
**achterkant** (welk model er écht draait) als de **cosmetische kant** (wat
`/model` in Claude Code toont). Alles is geverifieerd op 8 sep 2026 tegen
Claude Code 2.1.263. Historie van de oorspronkelijke methode: commit
`64c5711` en de DeepClaude-sessie van 2 sep 2026.

## Hoe het in elkaar zit (2 lagen)

```
Claude Code  ──►  deepclaude.sh (env-variabelen = de 5 "slots")
              ──►  dispatch-proxy op poort 3200 (per model-naam routeren)
              ──►  DeepSeek direct  of  OpenRouter (GLM/Kimi)
```

De rijen in `/model` ZIJN de env-variabelen die `deepclaude.sh` exporteert.
De proxy routeert op het begin van de modelnaam (`deepseek-v4-*` → DeepSeek,
`z-ai/*` en `moonshotai/*` → OpenRouter). Claude Code zelf weet niet eens dat
er een proxy tussen zit.

## Huidige indeling (smart, sinds 10 sep 2026)

| /model-rij      | env-variabele                    | Model                      | Provider    |
|-----------------|----------------------------------|----------------------------|-------------|
| Default         | `ANTHROPIC_MODEL` (in launch_smart) | `deepseek-flash[1m]`    | DeepSeek    |
| Opus            | `ANTHROPIC_DEFAULT_OPUS_MODEL`   | `deepseek-v4-pro[1m]`      | DeepSeek    |
| Sonnet          | `ANTHROPIC_DEFAULT_SONNET_MODEL` | `deepseek-flash[1m]`       | DeepSeek    |
| Fable           | `ANTHROPIC_DEFAULT_FABLE_MODEL`  | `moonshotai/kimi-k2.6`     | OpenRouter  |
| Haiku           | `ANTHROPIC_DEFAULT_HAIKU_MODEL`  | `z-ai/glm-5.2`             | OpenRouter  |
| (subagenten)    | `CLAUDE_CODE_SUBAGENT_MODEL`     | `deepseek-flash[1m]`       | DeepSeek    |

**Naamgeving sinds 10 sep 2026:** het Flash-model heet officieel
`deepseek-flash` en draait V4.1-Flash. `deepseek-v4-flash` werkt nog als
**legacy-alias** naar hetzelfde model (de respons geeft `deepseek-flash`
terug). De bèta-naam `deepseek-v4.1-flash-expires-on-0910` is vervallen; die
werkte op 10 sep nog, maar wordt ook al naar het productiemodel gestuurd.

⚠️ **V4 Pro faseert uit.** Vanaf **14 sep 2026** routeert DeepSeek alle
`deepseek-v4-pro`-requests naar V4.1 Flash tegen Flash-tarieven, tot een
toekomstige V4.1 Pro verschijnt. De Opus-rij levert dan dus hetzelfde model
als de rest — de rij blijft bestaan, maar is niet meer een ander model.

## Achterkant veranderen (welk model écht draait)

### 1. Slots in `deepclaude.sh` → `resolve_backend()` (smart-tak)

```bash
opus="deepseek-v4-pro"; sonnet="deepseek-flash"
haiku="z-ai/glm-5.2"; fable="moonshotai/kimi-k2.6"
subagent="deepseek-flash"
```

Regels:
- `[1m]` **niet hier typen** — `set_model_env()` plakt het er automatisch
  achter voor alles wat met `deepseek-` begint (1M-context, zie hieronder).
- GLM/Kimi krijgen bewust géén suffix (hun context is 128-256k).
- De proxy routeert op het begin van de naam: een nieuw model van een nieuwe
  provider heeft dus óók een nieuwe route nodig (stap 2).

### 2. Dispatch-routes in `proxy/start-proxy.js`

```js
routes = [
    { prefix: 'deepseek-', backend: 'deepseek' },
    { prefix: 'z-ai/', backend: 'openrouter' },
    { prefix: 'moonshotai/', backend: 'openrouter' },
];
```

Let op: de prefix is **`deepseek-`** (niet `deepseek-v4-`) — sinds 10 sep heet
het Flash-model `deepseek-flash`, zonder versienummer in de naam. OpenRouter-
slugs bevatten een slash (`deepseek/deepseek-...`) en matchen hier dus bewust
niet op; die gaan via hun eigen prefix naar OpenRouter.

Nieuwe provider = nieuw object hier + backend-definitie in `BACKEND_DEFS`
(url + naam van de key-env-var). Zonder match valt een model terug op
DeepSeek — en draait dus stilletjes op het verkeerde model.

### 3. De proxy: nooit blind killen

Poort 3200 is **gedeeld** door alle draaiende deepclaude-sessies. De launcher
health-checkt en hergebruikt. Alleen als `curl -s http://127.0.0.1:3200/_proxy/status`
niets geeft, mag hij opnieuw gestart worden (doet `launch_smart` zelf).
Handmatig alleen: `pkill -f "start-proxy.js --dispatch"` — en alleen als je
zeker weet dat er geen andere sessies draaien.

### 4. Default-rij veranderen

De Default-rij wordt ingesteld met `ANTHROPIC_MODEL`, in `launch_smart`:

```bash
set_model_env "deepseek-v4-flash[1m]"
```

- Dit wint bij opstart óók van een `"model"`-pin in settings.json.
- De andere launches (`-b ds`, `-b or`, `--remote`) geven `set_model_env ""`
  mee: geen override, dan geldt gewoon de Sonnet-slot als default.
- Let op de label-quirk (zie hieronder): het label van de Default-rij toont
  altijd de **Opus-slotwaarde**, niet het model dat de rij écht draait.

## Cosmetische kant (wat /model toont)

1. **De rijen zijn de env-slots.** Pas de env-variabelen aan en de rijen
   veranderen mee. Nieuwe env-var = nieuwe rij, direct zichtbaar na start.
2. **"currently X" bij de Default-rij is misleidend.** Claude Code bouwt dat
   label uit de Opus-slotwaarde (`Fie()` → `_6()` → `UL()` in de CLI-bundel).
   Er staat dus bijvoorbeeld "currently deepseek-v4-pro[1m]" terwijl de rij
   écht flash draait. Vertrouw bij twijfel op het ✔-vinkje en de proxy-log,
   niet op dat label.
3. **settings.json kan de boel "vervuild" achterlaten.** In `/model`:
   - **Enter** = model opslaan als je standaard voor nieuwe sessies → schrijft
     een `"model"`-pin in `~/.claude/settings.json`.
   - **`s`** = alleen deze sessie (wél doen).
   - Een pin in settings.json wint van de slots bij de eerstvolgende start —
     behalve als `ANTHROPIC_MODEL` is gezet (smart-mode; zie hierboven).
     Vandaar dat `/model` meldt "applies on restart" of juist niet.
   - Escape om alles te omzeilen: start één keer met
     `deepclaude -- --model deepseek-flash[1m]` (of via `/model` daarna).
4. **De `[1m]` in de rijnaam is normaal.** Claude Code plakt dat suffix zelf
   achter onbekende modellen; het hoort bij het 1M-mechanisme en wordt vóór
   het versturen weer gestript (door de CLI én door de proxy).

## Contextvenster (waarom [1m], en wat je níet moet doen)

- Zonder `[1m]` gelooft Claude Code dat een onbekend model 200k context
  heeft → auto-compact op 200k + waarschuwing. Mét `[1m]`: geloofd = 1M,
  geen waarschuwing, en de bèta-header `context-1m-2025-08-07` gaat mee.
  DeepSeek V4 accepteert die header.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` werkt **alleen** als ook `DISABLE_COMPACT`
  is gezet. En `CLAUDE_CODE_AUTO_COMPACT_WINDOW` wordt afgekapt op het
  geloofde venster. Daarom: **geen globale `MAX_CONTEXT_TOKENS` zetten** —
  die zou GLM/Kimi (verkeerd) ook raken. Het `[1m]`-suffix per DeepSeek-slot
  is de juiste, selectieve oplossing.

## Verifiëren (checklist na een wijziging)

```bash
bash -n ~/deepclaude/deepclaude.sh                 # 1. syntax (geen output = goed)
deepclaude --keys                                  # 2. keys werken
tail -f /tmp/deepclaude-proxy.log                  # 3. elke request: [MODEL-PROXY] #<id> (dispatch:<provider>, model=<naam>)
curl -s http://127.0.0.1:3200/_proxy/status        # 4. proxy gezond
```

In een verse `deepclaude`-sessie:
- `/model` → 5 rijen in de juiste volgorde; ✔ op de rij die je draait;
  **geen** 200k-waarschuwing/auto-compact-melding.
- In de proxy-log (of `claude --debug`): modelnaam zonder `[1m]` richting de
  provider; `anthropic-beta: context-1m-2025-08-07` aanwezig bij DeepSeek-calls.
- "Say exactly: FLASH-OK" (of PRO-OK) als snelle model-identiteitstest —
  het antwoord verraadt welk model echt antwoordt.

## 14 september 2026: V4 Pro faseert uit

DeepSeek routeert vanaf **14 sep 2026** alle `deepseek-v4-pro`-requests naar
V4.1 Flash tegen Flash-tarieven. De Opus-rij levert dan hetzelfde model als de
andere rijen.

**Wat te doen als dat eenmaal zo is:** niets haastigs — de rij blijft werken,
alleen met een ander onderliggend model. Wel eerlijk naar jezelf zijn bij het
kiezen: de Opus-rij is dan geen "zwaarder model" meer. Wil je echt een ander
model, gebruik dan Fable (Kimi) of Haiku (GLM).

Zodra DeepSeek een **V4.1 Pro** uitbrengt, is dat de naam om in de Opus-slot te
zetten — controleer dan `curl -s https://api.deepseek.com/models` voor de
exacte model-ID, want DeepSeek wijzigt namen (zie de `deepseek-flash`-rename).

## 10 september 2026: bèta vervallen, modelnaam gewijzigd

Doorgevoerd op 10 sep. Wat er is gebeurd:

1. **Modelnaam gewijzigd:** Flash heet nu officieel `deepseek-flash` (draait
   V4.1-Flash). `deepseek-v4-flash` is een legacy-alias naar hetzelfde model.
   Alle slots, de remap-tabel en de dispatch-prefix zijn bijgewerkt.
2. **Dispatch-prefix verruimd** van `deepseek-v4-` naar `deepseek-` — anders
   zou `deepseek-flash` niet meer gematcht worden en stil op de fallback
   belanden.
3. **Prijzen gedaald:** Flash $0.15 in / $0.60 uit (was $0.44/$0.87), dus de
   kostentabel in `model-proxy.js` is bijgewerkt.

**Les voor de volgende keer:** modelnamen bij DeepSeek zijn niet stabiel — ze
hernoemen zonder de oude naam meteen te killen. Check bij twijfel altijd
`curl -s https://api.deepseek.com/models` en het `model`-veld in de respons,
niet de documentatie alleen.
