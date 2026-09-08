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

## Huidige indeling (smart, sinds 8 sep 2026)

| /model-rij      | env-variabele                    | Model                                   | Provider    |
|-----------------|----------------------------------|-----------------------------------------|-------------|
| Default         | `ANTHROPIC_MODEL` (in launch_smart) | `deepseek-v4-flash[1m]`               | DeepSeek    |
| Opus            | `ANTHROPIC_DEFAULT_OPUS_MODEL`   | `deepseek-v4-pro[1m]`                   | DeepSeek    |
| Sonnet          | `ANTHROPIC_DEFAULT_SONNET_MODEL` | `deepseek-v4.1-flash-expires-on-0910[1m]` | DeepSeek |
| Fable           | `ANTHROPIC_DEFAULT_FABLE_MODEL`  | `moonshotai/kimi-k2.6`                  | OpenRouter  |
| Haiku           | `ANTHROPIC_DEFAULT_HAIKU_MODEL`  | `z-ai/glm-5.2`                          | OpenRouter  |
| (subagenten)    | `CLAUDE_CODE_SUBAGENT_MODEL`     | `deepseek-v4-flash[1m]`                 | DeepSeek    |

Let op: **Default ≠ Sonnet.** De Default-rij draait gewone flash via
`ANTHROPIC_MODEL`; de Sonnet-rij is 4.1-flash (bèta, vervalt 10 sep 2026 —
daarna moet die slot terug naar `deepseek-v4-flash`, zie onderaan).

## Achterkant veranderen (welk model écht draait)

### 1. Slots in `deepclaude.sh` → `resolve_backend()` (smart-tak)

```bash
opus="deepseek-v4-pro"; sonnet="deepseek-v4.1-flash-expires-on-0910"
haiku="z-ai/glm-5.2"; fable="moonshotai/kimi-k2.6"
subagent="deepseek-v4-flash"
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
    { prefix: 'deepseek-v4-', backend: 'deepseek' },
    { prefix: 'z-ai/', backend: 'openrouter' },
    { prefix: 'moonshotai/', backend: 'openrouter' },
];
```

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
     `deepclaude -- --model deepseek-v4-flash[1m]` (of via `/model` daarna).
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

## 10 september 2026: 4.1-flash-exp vervalt

Twee regels, meer niet:

1. `deepclaude.sh`, smart-tak: `sonnet="deepseek-v4-flash"` (was
   `deepseek-v4.1-flash-expires-on-0910`).
2. Help-tekst + MODELS.md aanpassen (deze tabel).

Daarna verifiëren met de checklist hierboven. Er staat een herinnering
ingesteld voor 10 sep 08:47.
