#!/usr/bin/env python3
"""Unit tests for script/render.py. Run from contracts/internal/gas-measurements."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import render  # noqa: E402

CHAINS = {key: json.loads(Path(f"results/{key}.json").read_text()) for key, _ in render.CHAINS}
DEPLOYED = json.loads(Path("results/deployed.json").read_text())
OPS = json.loads(Path("results/ops.json").read_text())


class ConsistencyTest(unittest.TestCase):
    def test_current_results_are_consistent(self):
        render.check_consistency(CHAINS, DEPLOYED)

    def test_rejects_other_tm_implementation(self):
        chains = copy.deepcopy(CHAINS)
        chains["sepolia"]["tmImpl"] = "0x" + "11" * 20
        with self.assertRaises(ValueError):
            render.check_consistency(chains, DEPLOYED)

    def test_rejects_other_fork_block(self):
        chains = copy.deepcopy(CHAINS)
        chains["arbitrum-sepolia"]["forkBlock"] += 1
        with self.assertRaises(ValueError):
            render.check_consistency(chains, DEPLOYED)

    def test_rejects_unverified_plaintexts_storage(self):
        deployed = copy.deepcopy(DEPLOYED)
        deployed["chains"]["sepolia"]["PlaintextsStorage"]["match"] = False
        with self.assertRaises(ValueError):
            render.check_consistency(CHAINS, deployed)


class ChainsMatchTest(unittest.TestCase):
    def test_current_results_match(self):
        exact, total = render.check_chains_match(CHAINS)
        self.assertEqual(total, len(OPS))
        self.assertGreater(exact, 0)

    def test_rejects_difference_visible_after_rounding(self):
        chains = copy.deepcopy(CHAINS)
        chains["arbitrum-sepolia"]["rows"]["add__euint8"]["first"] += 500
        with self.assertRaises(ValueError):
            render.check_chains_match(chains)

    def test_accepts_difference_hidden_by_rounding(self):
        chains = copy.deepcopy(CHAINS)
        row = chains["arbitrum-sepolia"]["rows"]["add__euint8"]
        row["first"] = round(row["first"] / 100) * 100 + 10
        chains["sepolia"]["rows"]["add__euint8"]["first"] = row["first"] - 20
        exact, total = render.check_chains_match(chains)
        self.assertLess(exact, total)


class OutputTest(unittest.TestCase):
    def setUp(self):
        render.main()
        self.md = Path("results/gas-tables.md").read_text()

    def test_one_table_set_for_both_chains(self):
        self.assertEqual(self.md.count("### Arithmetic"), 1)
        self.assertIn("## Ethereum Sepolia and Arbitrum Sepolia", self.md)
        self.assertNotIn("Chain difference summary", self.md)
        self.assertRegex(self.md, r"Arbitrum Sepolia: \d+ of \d+ rows equal Sepolia")

    def test_setup_table_lists_plaintexts_storage(self):
        self.assertIn("PlaintextsStorage implementation", self.md)

    def test_footnotes_for_state_dependent_cells(self):
        self.assertIn("non-zero result", self.md)          # publishDecrypt of 0 writes 0 -> 0
        self.assertIn("already allowed", self.md)          # isAllowed early-return path
        self.assertIn("reuses no operand", self.md)        # extra = independent second op

    def test_cast_spread_excludes_ebool_rewrite(self):
        type_table = render.type_summary(CHAINS["sepolia"]["rows"], OPS)
        cast = next(line for line in type_table.splitlines() if line.startswith("| Cast"))
        spreads = [int(c.strip().replace(",", "")) for c in cast.strip("|").split("|")[2:]]
        self.assertTrue(all(x < 1000 for x in spreads), cast)  # the ne(x, 0) rewrite adds ~30k


if __name__ == "__main__":
    unittest.main()
