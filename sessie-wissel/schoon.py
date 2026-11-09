#!/usr/bin/env python3
"""schoon.py - maakt een opgeschoonde KOPIE van een Claude Code-sessie.

Doel: een sessie die op het ene model draaide, kunnen hervatten op een ander model
(Anthropic <-> DeepClaude <-> BytePlus). Het origineel wordt nooit aangeraakt.
Alleen standaardbibliotheek. Print nooit gespreksinhoud, alleen aantallen.

Gebruik:
  schoon.py [--sessie ID|PAD] [--doel ruw|anthropic|deepclaude|byteplus]
            [--regels thinking,apireq,toolblocks,servertools,pairs] [--map PROJECTMAP]
Standaard: de nieuwste sessie in de projectmap van de huidige werkmap.
Zie ~/sessie-wisselen-plan.md voor achtergrond en aannames (A1-A12).
"""
import argparse
import collections
import copy
import datetime
import hashlib
import json
import os
import re
import sys
import uuid

PROJECTS = os.path.expanduser("~/.claude/projects")

# Welke filters per doel standaard aan staan. 'ruw' = alleen kopie + nieuw sessie-id.
# Dit zijn UITGANGSPUNTEN; Fase 0 van het plan meet welke echt nodig zijn.
DOELEN = {
    "ruw": set(),
    "anthropic": {"thinking", "pairs"},
    "deepclaude": {"thinking", "pairs"},
    "byteplus": {"thinking", "toolblocks", "servertools", "pairs", "woorden"},
}
ALLE_REGELS = {"thinking", "apireq", "toolblocks", "servertools", "pairs", "woorden"}
# Woorden die het inhoudsfilter van BytePlus ten onrechte laat weigeren (stop_reason=refusal, 0 tokens, ook op
# alle latere berichten omdat het woord in de geschiedenis blijft staan). Gemeten 9 nov 2026: "abbo"
# (Nederlands voor abonnement, in het Engels een scheldwoord) blokkeerde een hele sessie op elk model.
WOORDEN = [(re.compile(r"(?i)\babbos\b"), "abonnementen"), (re.compile(r"(?i)\babbo\b"), "abonnement")]
# Velden die naar een andere regel (uuid) verwijzen en dus meebewegen als die regel verdwijnt.
VERWIJZINGEN = ("parentUuid", "leafUuid", "sourceToolAssistantUUID")
BERICHT_TYPES = ("user", "assistant", "system", "api-request-blob")


def slug(pad):
    return re.sub(r"[^A-Za-z0-9]", "-", pad)


def projectmap(cwd=None):
    return os.path.join(PROJECTS, slug(cwd or os.getcwd()))


def vind_sessie(sessie, map_):
    if sessie and os.path.isfile(sessie):
        return sessie
    if sessie:
        naam = sessie if sessie.endswith(".jsonl") else sessie + ".jsonl"
        pad = os.path.join(map_, naam)
        if os.path.isfile(pad):
            return pad
        # Niet in de huidige projectmap: in alle projectmappen zoeken (een sessie kan in een andere map begonnen zijn).
        for d in os.listdir(PROJECTS):
            kandidaat = os.path.join(PROJECTS, d, naam)
            if os.path.isfile(kandidaat):
                return kandidaat
        raise SystemExit("sessie niet gevonden: %s" % sessie)
    kandidaten = [os.path.join(map_, f) for f in os.listdir(map_) if f.endswith(".jsonl")]
    if not kandidaten:
        raise SystemExit("geen sessies in %s" % map_)
    return max(kandidaten, key=os.path.getmtime)


def sha256(pad):
    h = hashlib.sha256()
    with open(pad, "rb") as f:
        for blok in iter(lambda: f.read(1 << 20), b""):
            h.update(blok)
    return h.hexdigest()


def tekst_van(inhoud):
    """Haal platte tekst uit een tool-resultaat; nooit de structuur laten lekken."""
    if isinstance(inhoud, str):
        return inhoud
    if isinstance(inhoud, list):
        delen = [b.get("text", "") for b in inhoud if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(d for d in delen if d)
    return ""


def omzetten_servertool(blok):
    """server_tool_use / advisor_tool_result -> korte tekst (inhoud blijft, formaat verdwijnt)."""
    if blok.get("type") == "server_tool_use":
        return {"type": "text", "text": "[%s geraadpleegd]" % blok.get("name", "hulpmiddel")}
    t = tekst_van(blok.get("content"))
    return {"type": "text", "text": ("[advies] " + t) if t else "[advies ontvangen]"}


def filter_inhoud(inhoud, regels, stats):
    """Pas de blokfilters toe op een lijst blokken. Geeft (nieuwe_lijst, veranderd)."""
    nieuw, veranderd = [], False
    for b in inhoud:
        bt = b.get("type") if isinstance(b, dict) else None
        if "thinking" in regels and bt in ("thinking", "redacted_thinking"):
            stats["denkblokken verwijderd"] += 1
            veranderd = True
            continue
        if "toolblocks" in regels and bt in ("tool_addition", "tool_removal"):
            stats["%s verwijderd" % bt] += 1
            veranderd = True
            continue
        if "servertools" in regels and bt in ("server_tool_use", "advisor_tool_result"):
            stats["%s omgezet naar tekst" % bt] += 1
            veranderd = True
            nieuw.append(omzetten_servertool(b))
            continue
        nieuw.append(b)
    return nieuw, veranderd


def eerste_pass(src):
    """Tel open tool-aanroepen (tool_use zonder tool_result) in de gespreksregels."""
    gebruikt, beantwoord = {}, set()
    with open(src, encoding="utf-8", errors="replace") as f:
        for regel in f:
            try:
                o = json.loads(regel)
            except ValueError:
                continue
            if o.get("type") not in ("user", "assistant"):
                continue
            inh = (o.get("message") or {}).get("content")
            if not isinstance(inh, list):
                continue
            for b in inh:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    gebruikt[b.get("id")] = o.get("uuid")
                elif b.get("type") == "tool_result":
                    beantwoord.add(b.get("tool_use_id"))
    return [i for i in gebruikt if i not in beantwoord], gebruikt


def schoon(src, dst, regels, nieuw_id, nu=None):
    """Schrijf een opgeschoonde kopie van src naar dst. Geeft stats terug."""
    stats = collections.Counter()
    open_ids, _ = eerste_pass(src) if "pairs" in regels else ([], {})
    redirect = {}          # verwijderde uuid -> ouder (om de keten te herstellen)
    laatste_uuid = None
    laatste_envelop = None
    with open(src, encoding="utf-8", errors="replace") as fin, open(dst, "w", encoding="utf-8") as fout:
        for ruw in fin:
            ruw = ruw.rstrip("\n")
            if not ruw.strip():
                continue
            if "woorden" in regels:
                for patroon, vervanging in WOORDEN:
                    ruw, aantal = patroon.subn(vervanging, ruw)
                    if aantal:
                        stats["woorden vervangen"] += aantal
            try:
                o = json.loads(ruw)
            except ValueError:
                fout.write(ruw + "\n")
                stats["onleesbare regels bewaard"] += 1
                continue
            t = o.get("type")
            if "apireq" in regels and isinstance(t, str) and t.startswith("api-request"):
                stats["api-request regels verwijderd"] += 1
                continue
            msg = o.get("message")
            if t in BERICHT_TYPES and isinstance(msg, dict) and isinstance(msg.get("content"), list):
                oorspronkelijk = len(msg["content"])
                nieuwe, veranderd = filter_inhoud(msg["content"], regels, stats)
                if veranderd:
                    msg["content"] = nieuwe
                    if oorspronkelijk and not nieuwe and t in ("user", "assistant", "system"):
                        # Lege berichten mogen niet blijven staan: regel weglaten, keten herstellen.
                        redirect[o.get("uuid")] = o.get("parentUuid")
                        stats["lege regels weggelaten"] += 1
                        continue
            if "sessionId" in o:
                o["sessionId"] = nieuw_id
            for veld in VERWIJZINGEN:
                v = o.get(veld)
                hops = 0
                while v in redirect and hops < 100000:
                    v = redirect[v]
                    hops += 1
                if veld in o and v != o.get(veld):
                    o[veld] = v
                    stats["verwijzingen hersteld"] += 1
            if t in ("user", "assistant") and o.get("uuid"):
                laatste_uuid = o["uuid"]
                laatste_envelop = {k: o[k] for k in ("cwd", "entrypoint", "gitBranch", "isSidechain",
                                                      "userType", "version") if k in o}
            fout.write(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n")
        if open_ids and laatste_uuid:
            stamp = nu or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            nieuw_uuid = str(uuid.uuid5(uuid.UUID(nieuw_id), "afgesloten:" + ",".join(open_ids)))
            regel = dict(laatste_envelop or {})
            regel.update({
                "type": "user", "uuid": nieuw_uuid, "parentUuid": laatste_uuid,
                "sessionId": nieuw_id, "timestamp": stamp,
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": i, "is_error": True,
                     "content": "[Wissel naar ander model: tool-aanroep afgebroken]"} for i in open_ids]},
            })
            fout.write(json.dumps(regel, ensure_ascii=False, separators=(",", ":")) + "\n")
            stats["open tool-aanroepen afgesloten"] += len(open_ids)
    return stats


def controleer(pad):
    """Diagnose van de uitvoer (geen inhoud): verweesde verwijzingen, ontbrekende koppelingen, rollen."""
    uuids, rijen = set(), []
    with open(pad, encoding="utf-8") as f:
        for regel in f:
            o = json.loads(regel)
            if o.get("type") in ("user", "assistant"):
                rijen.append(o)
                uuids.add(o.get("uuid"))
    verweesd = sum(1 for o in rijen if o.get("parentUuid") and o["parentUuid"] not in uuids)
    gebruikt, beantwoord = set(), set()
    for o in rijen:
        for b in (o.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                gebruikt.add(b["id"])
            if isinstance(b, dict) and b.get("type") == "tool_result":
                beantwoord.add(b.get("tool_use_id"))
    dubbel = 0
    vorige = None
    for o in rijen:
        rol = (o.get("message") or {}).get("role", o.get("type"))
        if rol == vorige == "user":
            dubbel += 1
        vorige = rol
    return {"berichtregels": len(rijen), "verweesde parentUuid": verweesd,
            "tool_use zonder tool_result": len(gebruikt - beantwoord),
            "tool_result zonder tool_use": len(beantwoord - gebruikt),
            "opeenvolgende gebruikersregels": dubbel}


def info(src):
    """Kerngegevens van een sessie voor het wissel-logboek (geen inhoud): id, laatste model, leeftijd, regels."""
    model, regels, titel = "onbekend", 0, ""
    with open(src, encoding="utf-8", errors="replace") as f:
        for regel in f:
            regels += 1
            if '"ai-title"' in regel:
                try:
                    o = json.loads(regel)
                    if o.get("type") == "ai-title" and o.get("aiTitle"):
                        titel = " ".join(str(o["aiTitle"]).split())[:70]
                except ValueError:
                    pass
                continue
            if '"assistant"' not in regel or '"model"' not in regel:
                continue
            try:
                o = json.loads(regel)
            except ValueError:
                continue
            m = (o.get("message") or {}).get("model")
            if o.get("type") == "assistant" and m and m != "<synthetic>":
                model = m
    uren = (datetime.datetime.now().timestamp() - os.path.getmtime(src)) / 3600.0
    return os.path.basename(src)[:-6], model, round(uren, 1), regels, titel


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "--scan":
        # schoon.py --scan ID|PAD  ->  aantal woorden in de sessie die BytePlus ten onrechte weigert
        src = vind_sessie(argv[1] if len(argv) > 1 else None, projectmap())
        totaal = 0
        with open(src, encoding="utf-8", errors="replace") as f:
            for regel in f:
                totaal += sum(len(p.findall(regel)) for p, _ in WOORDEN)
        print(totaal)
        return 0
    if argv and argv[0] == "--cwd":
        # schoon.py --cwd ID|PAD  ->  de werkmap waarin de sessie begon (uit de regels zelf)
        src = vind_sessie(argv[1] if len(argv) > 1 else None, projectmap())
        gevonden = ""
        with open(src, encoding="utf-8", errors="replace") as f:
            for regel in f:
                if '"cwd"' not in regel:
                    continue
                try:
                    c = json.loads(regel).get("cwd")
                except ValueError:
                    continue
                if c and os.path.isdir(c):
                    gevonden = c
                    break
        if not gevonden:
            raise SystemExit("werkmap van de sessie niet te bepalen")
        print(gevonden)
        return 0
    if argv and argv[0] == "--info":
        # schoon.py --info [ID|PAD]  ->  id<TAB>model<TAB>leeftijd_uur<TAB>regels<TAB>titel
        src = vind_sessie(argv[1] if len(argv) > 1 else None, projectmap())
        print("\t".join(str(x) for x in info(src)))
        return 0
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sessie", help="sessie-id of pad (standaard: nieuwste in de projectmap)")
    p.add_argument("--doel", default="byteplus", choices=sorted(DOELEN))
    p.add_argument("--regels", help="komma-lijst die het doel-profiel overschrijft: " + ",".join(sorted(ALLE_REGELS)))
    p.add_argument("--map", help="projectmap in ~/.claude/projects (standaard: van de huidige werkmap)")
    p.add_argument("--nieuw-id", help="vast uuid voor de kopie (voor tests)")
    a = p.parse_args(argv)
    map_ = a.map or projectmap()
    src = vind_sessie(a.sessie, map_)
    regels = set(DOELEN[a.doel])
    if a.regels is not None:
        regels = {r for r in a.regels.split(",") if r}
        onbekend = regels - ALLE_REGELS
        if onbekend:
            raise SystemExit("onbekende regel(s): %s" % ",".join(sorted(onbekend)))
    nieuw_id = a.nieuw_id or str(uuid.uuid4())
    dst = os.path.join(os.path.dirname(os.path.abspath(src)), nieuw_id + ".jsonl")
    if os.path.exists(dst):
        raise SystemExit("doelbestand bestaat al: %s" % dst)
    voor = sha256(src)
    stats = schoon(src, dst, regels, nieuw_id)
    na = sha256(src)
    uit = controleer(dst)
    print("bron:        %s" % os.path.basename(src))
    print("kopie:       %s" % nieuw_id)
    print("filters:     %s" % (",".join(sorted(regels)) or "(geen: ruwe kopie)"))
    for k, v in sorted(stats.items()):
        print("  %-38s %d" % (k, v))
    print("controle:    " + ", ".join("%s=%s" % kv for kv in uit.items()))
    print("origineel onaangetast: %s" % ("ja" if voor == na else "NEE - STOP, er is iets mis"))
    print("hervatten:   claude --resume %s" % nieuw_id)
    return 0 if voor == na else 2


if __name__ == "__main__":
    sys.exit(main())
