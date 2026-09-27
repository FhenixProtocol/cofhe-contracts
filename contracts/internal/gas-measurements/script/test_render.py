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
TOKENS = {name: {key: json.loads(Path(f"results/{name}-{key}.json").read_text()) for key, _ in render.CHAINS}
          for name in render.TOKENS}


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


class TokenTest(unittest.TestCase):
    def test_current_results_pass(self):
        render.check_tokens(TOKENS, DEPLOYED)

    def test_rejects_chain_difference(self):
        tokens = copy.deepcopy(TOKENS)
        tokens["erc20confidential"]["arbitrum-sepolia"]["rows"]["confidentialTransferToHolder"] += 500
        with self.assertRaises(ValueError):
            render.check_tokens(tokens, DEPLOYED)

    def test_rejects_other_tm_implementation(self):
        tokens = copy.deepcopy(TOKENS)
        tokens["fherc20"]["sepolia"]["tmImpl"] = "0x" + "11" * 20
        with self.assertRaises(ValueError):
            render.check_tokens(tokens, DEPLOYED)


class OutputTest(unittest.TestCase):
    def setUp(self):
        render.main()
        self.md = Path("results/gas-tables.md").read_text()

    def test_one_table_set_for_both_chains(self):
        self.assertEqual(self.md.count("### Arithmetic"), 1)
        self.assertIn("## Ethereum Sepolia and Arbitrum Sepolia", self.md)
        self.assertNotIn("Chain difference summary", self.md)
        self.assertRegex(self.md, r"Arbitrum Sepolia: \d+ of \d+ rows equal Sepolia")

    def test_token_sections(self):
        self.assertIn("### FHERC20 transfer (whole transaction)", self.md)
        self.assertIn("`confidentialTransfer` to an existing holder", self.md)
        self.assertIn("5138cb8", self.md)
        self.assertIn("### ERC20Confidential transfer (whole transaction)", self.md)
        self.assertIn("with an observer set", self.md)

    def test_setup_table_lists_plaintexts_storage(self):
        self.assertIn("PlaintextsStorage implementation", self.md)

    def test_footnotes_for_state_dependent_cells(self):
        self.assertIn("non-zero result", self.md)          # publishDecrypt of 0 writes 0 -> 0
        self.assertIn("already allowed", self.md)          # isAllowed early-return path
        self.assertIn("reuses no operand", self.md)        # extra = independent second op

    def test_one_value_per_op(self):
        self.assertIn("| Operation | first | extra | Types | Type spread (gas) |", self.md)
        self.assertNotIn("| Operation | ebool |", self.md)
        self.assertIn("Cast to `ebool`", self.md)
        self.assertNotIn("Type dependence summary", self.md)


class TypeSpreadTest(unittest.TestCase):
    def test_current_results_within_limit(self):
        render.check_type_spread(CHAINS["sepolia"]["rows"], OPS)

    def test_rejects_type_dependent_op(self):
        rows = copy.deepcopy(CHAINS["sepolia"]["rows"])
        rows["add__euint128"]["first"] += render.TYPE_SPREAD_LIMIT + 1
        with self.assertRaises(ValueError):
            render.check_type_spread(rows, OPS)

    def test_cast_to_ebool_is_its_own_group(self):
        render.check_type_spread(CHAINS["sepolia"]["rows"], OPS)  # would fail if ~30k rewrite were grouped in

if __name__ == "__main__":
    unittest.main()
