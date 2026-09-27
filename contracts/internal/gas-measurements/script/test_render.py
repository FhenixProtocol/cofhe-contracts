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


class OutputTest(unittest.TestCase):
    def setUp(self):
        render.main()
        self.md = Path("results/gas-tables.md").read_text()

    def test_setup_table_lists_plaintexts_storage(self):
        self.assertIn("PlaintextsStorage implementation", self.md)

    def test_footnotes_for_state_dependent_cells(self):
        self.assertIn("non-zero result", self.md)          # publishDecrypt of 0 writes 0 -> 0
        self.assertIn("already allowed", self.md)          # isAllowed early-return path
        self.assertIn("reuses no operand", self.md)        # extra = independent second op

    def test_cast_spread_excludes_ebool_rewrite(self):
        type_table, _ = render.summaries(CHAINS, OPS)
        cast = next(line for line in type_table.splitlines() if line.startswith("| Cast"))
        spreads = [int(c.strip().replace(",", "")) for c in cast.strip("|").split("|")[2:]]
        self.assertTrue(all(x < 1000 for x in spreads), cast)  # the ne(x, 0) rewrite adds ~30k


if __name__ == "__main__":
    unittest.main()
