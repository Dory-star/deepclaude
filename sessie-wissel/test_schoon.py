#!/usr/bin/env python3
"""Tests voor schoon.py met een nep-sessie (geen echte gesprekken, geen netwerk).
Draaien: python3 -I sessie-wissel/test_schoon.py"""
import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schoon  # noqa: E402

OUD = "11111111-1111-4111-8111-111111111111"
NIEUW = "22222222-2222-4222-8222-222222222222"


def regel(**kw):
    return kw


def nep_sessie():
    """Gesprek met: denk-alleen-regels, een tool-aanroep met resultaat, api-request-regels,
    een server_tool_use/advisor_tool_result, en aan het eind een OPEN tool_use."""
    env = {"sessionId": OUD, "cwd": "/x", "version": "1", "userType": "external", "isSidechain": False,
           "entrypoint": "cli", "gitBranch": "main"}
    def m(t, uuid, parent, blocks, **extra):
        r = dict(env, type=t, uuid=uuid, parentUuid=parent,
                 message={"role": t, "content": blocks}, timestamp="2026-11-09T00:00:00.000Z")
        r.update(extra)
        return r
    return [
        m("user", "u1", None, [{"type": "text", "text": "hallo"}]),
        m("assistant", "a1", "u1", [{"type": "thinking", "thinking": "hmm", "signature": "sig"}]),
        m("assistant", "a2", "a1", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]),
        m("user", "u2", "a2", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}],
          sourceToolAssistantUUID="a2"),
        m("assistant", "a3", "u2", [{"type": "thinking", "thinking": "nog eens", "signature": "sig2"}]),
        m("assistant", "a4", "a3", [{"type": "text", "text": "klaar"}]),
        {"type": "api-request", "sessionId": OUD, "requestDigest": "x"},
        {"type": "api-request-blob", "sessionId": OUD, "hash": "h",
         "message": {"role": "system", "content": [{"type": "tool_addition", "tool": {"type": "tool_reference", "name": "n"}}]}},
        m("assistant", "a5", "a4", [{"type": "server_tool_use", "id": "s1", "name": "advisor", "input": {}}]),
        m("assistant", "a6", "a5", [{"type": "advisor_tool_result", "tool_use_id": "s1", "content": "advies tekst"}]),
        m("assistant", "a7", "a6", [{"type": "tool_use", "id": "t2", "name": "Write", "input": {}}]),
        {"type": "last-prompt", "sessionId": OUD, "leafUuid": "a3", "lastPrompt": "x"},
    ]


class SchoonTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.src = os.path.join(self.d, OUD + ".jsonl")
        with open(self.src, "w") as f:
            for r in nep_sessie():
                f.write(json.dumps(r) + "\n")
        self.sha = hashlib.sha256(open(self.src, "rb").read()).hexdigest()

    def draai(self, regels, src=None, nieuw=NIEUW):
        dst = os.path.join(self.d, nieuw + ".jsonl")
        if os.path.exists(dst):
            os.remove(dst)
        stats = schoon.schoon(src or self.src, dst, set(regels), nieuw, nu="2026-11-09T01:00:00.000Z")
        rows = []
        for l in open(dst):
            try:
                rows.append(json.loads(l))
            except ValueError:
                pass  # bewust onleesbare regel (zie test_onleesbare_regel_blijft_staan)
        return stats, rows, dst

    def test_origineel_blijft_onaangetast(self):
        self.draai({"thinking", "apireq", "toolblocks", "servertools", "pairs"})
        self.assertEqual(self.sha, hashlib.sha256(open(self.src, "rb").read()).hexdigest())

    def test_ruw_zet_alleen_het_sessie_id(self):
        _, rows, _ = self.draai(set())
        orig = nep_sessie()
        self.assertEqual(len(rows), len(orig))
        for r in rows:
            self.assertEqual(r["sessionId"], NIEUW)
        # inhoud verder gelijk
        for r, o in zip(rows, orig):
            o = dict(o, sessionId=NIEUW)
            self.assertEqual(r, o)

    def test_thinking_weg_en_keten_hersteld(self):
        stats, rows, _ = self.draai({"thinking"})
        uuids = {r.get("uuid"): r for r in rows if r.get("uuid")}
        self.assertNotIn("a1", uuids)
        self.assertNotIn("a3", uuids)
        self.assertEqual(uuids["a2"]["parentUuid"], "u1")      # a1 verdween, a2 hangt nu aan u1
        self.assertEqual(uuids["a4"]["parentUuid"], "u2")      # a3 verdween, a4 hangt nu aan u2
        lp = [r for r in rows if r["type"] == "last-prompt"][0]
        self.assertEqual(lp["leafUuid"], "u2")                 # ook verwijzingen buiten de keten
        self.assertEqual(stats["denkblokken verwijderd"], 2)
        for r in rows:                                         # nergens een verweesde parent
            if r.get("parentUuid"):
                self.assertIn(r["parentUuid"], uuids)

    def test_apireq_weg(self):
        stats, rows, _ = self.draai({"apireq"})
        self.assertFalse([r for r in rows if r["type"].startswith("api-request")])
        self.assertEqual(stats["api-request regels verwijderd"], 2)

    def test_toolblocks_in_blob_weg(self):
        stats, rows, _ = self.draai({"toolblocks"})
        blob = [r for r in rows if r["type"] == "api-request-blob"][0]
        self.assertEqual(blob["message"]["content"], [])       # blob blijft staan, blok eruit
        self.assertEqual(stats["tool_addition verwijderd"], 1)

    def test_servertools_naar_tekst(self):
        _, rows, _ = self.draai({"servertools"})
        a5 = [r for r in rows if r.get("uuid") == "a5"][0]
        a6 = [r for r in rows if r.get("uuid") == "a6"][0]
        self.assertEqual(a5["message"]["content"][0]["type"], "text")
        self.assertIn("advies tekst", a6["message"]["content"][0]["text"])

    def test_open_tool_use_wordt_afgesloten(self):
        stats, rows, _ = self.draai({"pairs"})
        laatste = rows[-1]
        self.assertEqual(laatste["type"], "user")
        blok = laatste["message"]["content"][0]
        self.assertEqual((blok["type"], blok["tool_use_id"], blok["is_error"]), ("tool_result", "t2", True))
        self.assertEqual(laatste["parentUuid"], "a7")
        self.assertEqual(stats["open tool-aanroepen afgesloten"], 1)

    def test_idempotent(self):
        alles = {"thinking", "apireq", "toolblocks", "servertools", "pairs"}
        _, _, eerste = self.draai(alles)
        tweede_pad = os.path.join(self.d, "tweede.jsonl")
        schoon.schoon(eerste, tweede_pad, alles, NIEUW, nu="2026-11-09T01:00:00.000Z")
        self.assertEqual(open(eerste).read(), open(tweede_pad).read())

    def test_controle_ziet_geen_problemen_na_volledige_schoonmaak(self):
        _, _, dst = self.draai({"thinking", "apireq", "toolblocks", "servertools", "pairs"})
        c = schoon.controleer(dst)
        self.assertEqual(c["verweesde parentUuid"], 0)
        self.assertEqual(c["tool_use zonder tool_result"], 0)
        self.assertEqual(c["tool_result zonder tool_use"], 0)

    def test_filterwoord_wordt_vervangen(self):
        with open(self.src, "a") as f:
            f.write(json.dumps({"type": "user", "uuid": "u9", "parentUuid": "a7", "sessionId": OUD,
                                "message": {"role": "user", "content": "oke ik heb een 10 Abbo genomen, abbos blijven staan"}}) + "\n")
        stats, rows, _ = self.draai({"woorden"})
        tekst = json.dumps(rows[-1], ensure_ascii=False)
        self.assertIn("10 abonnement genomen", tekst)
        self.assertIn("abonnementen blijven staan", tekst)   # ook het meervoud
        self.assertNotIn("Abbo ", tekst)
        self.assertEqual(stats["woorden vervangen"], 2)
        # alleen hele woorden: een ander woord dat met 'abbo' begint blijft staan
        with open(self.src, "a") as f:
            f.write(json.dumps({"type": "user", "uuid": "u10", "parentUuid": "u9", "sessionId": OUD,
                                "message": {"role": "user", "content": "abbotsford en gabbo blijven"}}) + "\n")
        _, rows2, _ = self.draai({"woorden"})
        self.assertIn("abbotsford en gabbo blijven", json.dumps(rows2[-1], ensure_ascii=False))

    def test_scan_telt_filterwoorden(self):
        with open(self.src, "a") as f:
            f.write(json.dumps({"type": "user", "uuid": "u9", "message": {"role": "user", "content": "abbo en ABBO"}}) + "\n")
        telling = sum(len(p.findall(l)) for l in open(self.src) for p, _ in schoon.WOORDEN)
        self.assertEqual(telling, 2)

    def test_onleesbare_regel_blijft_staan(self):
        with open(self.src, "a") as f:
            f.write("dit is geen json\n")
        stats, _, dst = self.draai({"thinking"})
        self.assertIn("dit is geen json", open(dst).read())
        self.assertEqual(stats["onleesbare regels bewaard"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
