#!/usr/bin/env python3
"""Tests for analysis/build_week7_pairs.py and check_week7_distances.py.

IMPORTANT: these tests use SYNTHETIC random page vectors (flagged
"synthetic": true in their cache) in temporary directories. They exercise the
pipeline logic (pair table, cache invalidation, safeguards, determinism); they
say nothing about real similarity scores and never write to data/week7/.

Run from the repository root:

    python analysis/test_week7_pairs.py
"""

import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
os.environ["WEEK7_ALLOW_SYNTHETIC_CACHE"] = "1"

import build_week7_pairs as bp      # noqa: E402
import check_week7_distances as chk  # noqa: E402

NODES, IDS, INDEX, EDGES, _INFO, TEXTS, SOURCE = bp.load_characters()
N = len(IDS)


def no_model():
    """Simulate an environment where the embedding model cannot be used (never embeds for real)."""
    return mock.patch.object(bp, "embed_pages",
                             side_effect=bp.UserError("sentence-transformers is not available (simulated)"))


def quiet(fn, *a, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        return fn(*a, **kw), buf.getvalue()


def write_synthetic_cache(directory, seed=0, **meta_over):
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(N, 384)).astype("float32")
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    meta = {"model": bp.w7.MODEL_NAME, "passage_words": bp.w7.PASSAGE_WORDS, "method_version": bp.METHOD_VERSION,
            "synthetic": True, "max_seq_length": 256, "dim": 384, "sentence_transformers": "SYNTHETIC-TEST"}
    meta.update(meta_over)
    np.savez_compressed(Path(directory) / bp.EMB_NAME, ids=np.array(IDS), vectors=v, ok=np.ones(N, bool),
                        text_sha256=np.array([bp.sha256(TEXTS[i]) for i in IDS]), meta=np.array(json.dumps(meta)))
    return v


def load_cache(directory):
    with np.load(Path(directory) / bp.EMB_NAME, allow_pickle=False) as c:
        return {k: c[k] for k in c.files}


class CacheInvalidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        write_synthetic_cache(self.tmp.name)
        self.cache = load_cache(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def problem(self, cache=None, texts=None, source=None, passage_words=180, model=None):
        return bp.cache_problem(cache or self.cache, IDS, texts or TEXTS, source or SOURCE, passage_words,
                                model or bp.w7.MODEL_NAME)

    def test_valid_cache_accepted(self):
        self.assertIsNone(self.problem())

    def test_changed_text_invalidates(self):
        texts = dict(TEXTS)
        texts[IDS[5]] += " One more sentence."
        self.assertIn("texts changed", self.problem(texts=texts))

    def test_changed_model_or_passage_setting_invalidates(self):
        self.assertIn("model differs", self.problem(model="all-MiniLM-L12-v2"))
        self.assertIn("passage_words", self.problem(passage_words=150))

    def test_changed_ids_invalidate(self):
        c = dict(self.cache)
        c["ids"] = np.array(IDS[::-1])
        self.assertIn("ids differ", self.problem(cache=c))

    def test_method_version_invalidates(self):
        c = dict(self.cache)
        c["meta"] = np.array(json.dumps({**json.loads(str(c["meta"])), "method_version": "old"}))
        self.assertIn("method version", self.problem(cache=c))

    def test_non_unit_vectors_invalidate(self):
        c = dict(self.cache)
        c["vectors"] = c["vectors"] * 2
        self.assertIn("unit length", self.problem(cache=c))

    def test_synthetic_cache_refused_without_env_flag(self):
        old = os.environ.pop(bp.SYNTHETIC_ENV)
        try:
            self.assertIn("synthetic", self.problem())
        finally:
            os.environ[bp.SYNTHETIC_ENV] = old


class FullPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        write_synthetic_cache(cls.out)
        _, cls.log = quiet(bp.main, ["--out-dir", str(cls.out), "--skip-consistency-check"])
        cls.rows = [ln.split("\t") for ln in (cls.out / bp.PAIRS_NAME).read_text(encoding="utf-8").splitlines()
                    if ln and not ln.startswith("#")]
        cls.header, cls.rows = cls.rows[0], [dict(zip(cls.rows[0], r)) for r in cls.rows[1:]]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_pair_count_and_uniqueness(self):
        self.assertEqual(len(self.rows), N * (N - 1) // 2)
        self.assertEqual(len(self.rows), 68265)
        keys = [(r["a"], r["b"]) for r in self.rows]
        self.assertEqual(len(set(keys)), len(keys))
        self.assertTrue(all(a < b for a, b in keys))
        self.assertEqual(keys, sorted(keys))

    def test_unreachable_pairs_have_no_distance(self):
        none = [r for r in self.rows if r["reach"] == "none"]
        self.assertTrue(none)
        self.assertTrue(all(r["d_ab"] == "" and r["d_ba"] == "" for r in none))
        self.assertTrue(all(r["d_ab"] != "" or r["d_ba"] != "" for r in self.rows if r["reach"] != "none"))

    def test_featured_pair_distances(self):
        by = {(r["a"], r["b"]): r for r in self.rows}
        r = by[("Firebrand_(Marvel_Comics)", "Firepower_(comics)")]
        self.assertEqual((r["d_ab"], r["d_ba"], r["reach"]), ("7", "", "a_to_b"))
        r = by[("Gentleman_(character)", "Masked_Marauder")]
        self.assertEqual((r["d_ab"], r["d_ba"], r["reach"], r["same_scc"]), ("6", "6", "both", "1"))

    def test_complete_flag_and_digests(self):
        meta = json.loads((self.out / bp.CHARACTERS_NAME).read_text(encoding="utf-8"))["meta"]
        self.assertIs(meta["complete"], True)
        self.assertEqual(set(meta["outputs"]), {bp.PAIRS_NAME, bp.SUMMARY_NAME})

    def test_checker_passes_on_synthetic_output(self):
        shutil_copy = self.out / "week7_supervillains.json"
        shutil_copy.write_bytes((bp.DEFAULT_OUT / "week7_supervillains.json").read_bytes())
        code, text = quiet(chk.main, ["--data-dir", str(self.out), "--skip-stored-cosine", "--allow-synthetic"])
        self.assertEqual(code, 0, text)
        code, text = quiet(chk.main, ["--data-dir", str(self.out), "--skip-stored-cosine"])
        self.assertEqual(code, 1, "synthetic datasets must be flagged unless explicitly allowed")

    def test_checker_detects_a_corrupted_distance(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            for f in (bp.CHARACTERS_NAME, bp.SUMMARY_NAME, bp.PAIRS_NAME):
                (t / f).write_bytes((self.out / f).read_bytes())
            (t / "week7_supervillains.json").write_bytes((bp.DEFAULT_OUT / "week7_supervillains.json").read_bytes())
            text = (t / bp.PAIRS_NAME).read_text(encoding="utf-8")
            bad = text.replace("Firebrand_(Marvel_Comics)\tFirepower_(comics)", "Firebrand_(Marvel_Comics)\tFirepower_(comics)", 1)
            lines = bad.split("\n")
            k = next(i for i, ln in enumerate(lines) if ln.startswith("Firebrand_(Marvel_Comics)\tFirepower_(comics)"))
            cells = lines[k].split("\t")
            cells[3] = "3"
            lines[k] = "\t".join(cells)
            (t / bp.PAIRS_NAME).write_text("\n".join(lines), encoding="utf-8")
            code, _ = quiet(chk.main, ["--data-dir", str(t), "--skip-stored-cosine", "--allow-synthetic"])
            self.assertEqual(code, 1)

    def test_rerun_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            (t / bp.EMB_NAME).write_bytes((self.out / bp.EMB_NAME).read_bytes())
            quiet(bp.main, ["--out-dir", str(t), "--skip-consistency-check"])
            for f in (bp.PAIRS_NAME, bp.SUMMARY_NAME, bp.CHARACTERS_NAME):
                self.assertEqual((t / f).read_bytes(), (self.out / f).read_bytes(), f)

    def test_random_vectors_fail_the_consistency_check(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            (t / bp.EMB_NAME).write_bytes((self.out / bp.EMB_NAME).read_bytes())
            (t / "week7_supervillains.json").write_bytes((bp.DEFAULT_OUT / "week7_supervillains.json").read_bytes())
            with self.assertRaises(bp.UserError) as cm:
                quiet(bp.main, ["--out-dir", str(t)])
            self.assertIn("disagree", str(cm.exception))
            self.assertFalse((t / bp.PAIRS_NAME).exists(), "nothing may be written when the check fails")

    def test_failed_run_leaves_existing_outputs_untouched(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            for f in (bp.EMB_NAME, bp.CHARACTERS_NAME, bp.SUMMARY_NAME, bp.PAIRS_NAME):
                (t / f).write_bytes((self.out / f).read_bytes())
            before = {f.name: f.read_bytes() for f in t.iterdir()}
            with no_model(), self.assertRaises(bp.UserError):   # new passage setting -> cache invalid -> cannot re-embed
                quiet(bp.main, ["--out-dir", str(t), "--passage-words", "150"])
            self.assertEqual(before, {f.name: f.read_bytes() for f in t.iterdir()})


class TransactionalWrite(unittest.TestCase):
    NAMES = (bp.PAIRS_NAME, bp.SUMMARY_NAME, bp.CHARACTERS_NAME)

    def make_dir(self, t, existing):
        for name in existing:
            (Path(t) / name).write_text("old " + name, encoding="utf-8")

    def failing_replace(self, fail_on_call):
        real, calls = os.replace, {"n": 0}

        def wrapper(src, dst):
            calls["n"] += 1
            if calls["n"] == fail_on_call:
                raise OSError("simulated failure")
            return real(src, dst)
        return wrapper

    def test_failure_at_every_step_restores_the_old_files(self):
        new = {n: "new " + n for n in self.NAMES}
        for fail_on in range(1, 7):                      # 3 files x (old->bak, tmp->dst)
            with tempfile.TemporaryDirectory() as t:
                self.make_dir(t, self.NAMES)
                with mock.patch.object(bp.os, "replace", self.failing_replace(fail_on)):
                    with self.assertRaises(OSError):
                        bp.commit_outputs(Path(t), new, list(self.NAMES))
                self.assertEqual({f.name: f.read_text(encoding="utf-8") for f in Path(t).iterdir()},
                                 {n: "old " + n for n in self.NAMES}, f"failed on replace #{fail_on}")

    def test_failure_with_no_previous_files_leaves_nothing(self):
        new = {n: "new " + n for n in self.NAMES}
        for fail_on in range(1, 4):                      # 3 files x (tmp->dst)
            with tempfile.TemporaryDirectory() as t:
                with mock.patch.object(bp.os, "replace", self.failing_replace(fail_on)):
                    with self.assertRaises(OSError):
                        bp.commit_outputs(Path(t), new, list(self.NAMES))
                self.assertEqual(list(Path(t).iterdir()), [], f"failed on replace #{fail_on}")

    def test_success_replaces_everything_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as t:
            self.make_dir(t, self.NAMES[:2])
            bp.commit_outputs(Path(t), {n: "new " + n for n in self.NAMES}, list(self.NAMES))
            self.assertEqual({f.name: f.read_text(encoding="utf-8") for f in Path(t).iterdir()},
                             {n: "new " + n for n in self.NAMES})

    def test_leftover_backups_are_restored_on_the_next_run(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            (t / (bp.PAIRS_NAME + ".bak")).write_text("old pairs", encoding="utf-8")
            (t / bp.PAIRS_NAME).write_text("half-written new", encoding="utf-8")
            (t / (bp.SUMMARY_NAME + ".tmp")).write_text("stale", encoding="utf-8")
            quiet(bp.recover_interrupted, t)
            self.assertEqual({f.name: f.read_text(encoding="utf-8") for f in t.iterdir()},
                             {bp.PAIRS_NAME: "old pairs"})


class GraphOnlySafeguard(unittest.TestCase):
    def test_graph_only_in_empty_dir_is_allowed_and_marked_incomplete(self):
        with tempfile.TemporaryDirectory() as t:
            quiet(bp.main, ["--out-dir", t, "--graph-only"])
            meta = json.loads((Path(t) / bp.CHARACTERS_NAME).read_text(encoding="utf-8"))["meta"]
            self.assertIs(meta["complete"], False)
            self.assertFalse((Path(t) / bp.PAIRS_NAME).exists())
            quiet(bp.main, ["--out-dir", t, "--graph-only"])      # re-running over a graph-only file is fine

    def test_graph_only_refuses_to_overwrite_a_full_dataset(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            write_synthetic_cache(t)
            quiet(bp.main, ["--out-dir", str(t), "--skip-consistency-check"])
            before = {f.name: f.read_bytes() for f in t.iterdir()}
            with self.assertRaises(bp.UserError) as cm:
                quiet(bp.main, ["--out-dir", str(t), "--graph-only"])
            self.assertIn("force-overwrite-full", str(cm.exception))
            self.assertEqual(before, {f.name: f.read_bytes() for f in t.iterdir()})
            quiet(bp.main, ["--out-dir", str(t), "--graph-only", "--force-overwrite-full"])
            meta = json.loads((t / bp.CHARACTERS_NAME).read_text(encoding="utf-8"))["meta"]
            self.assertIs(meta["complete"], False)

    def test_graph_only_refuses_when_only_a_pair_table_exists(self):
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / bp.PAIRS_NAME).write_text("x", encoding="utf-8")
            with self.assertRaises(bp.UserError):
                quiet(bp.main, ["--out-dir", t, "--graph-only"])

    def test_graph_only_refuses_an_unparseable_characters_file(self):
        with tempfile.TemporaryDirectory() as t:
            (Path(t) / bp.CHARACTERS_NAME).write_text("{not json", encoding="utf-8")
            with self.assertRaises(bp.UserError):
                quiet(bp.main, ["--out-dir", t, "--graph-only"])

    def test_missing_embeddings_without_graph_only_writes_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            with no_model(), self.assertRaises(bp.UserError) as cm:
                quiet(bp.main, ["--out-dir", t])
            self.assertIn("sentence-transformers", str(cm.exception))
            self.assertEqual(list(Path(t).iterdir()), [])


class SimilarityValidation(unittest.TestCase):
    def test_accepts_a_proper_cosine_matrix(self):
        v = np.random.default_rng(1).normal(size=(5, 8))
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        bp.validate_similarity(v @ v.T, np.ones(5, bool))

    def test_rejects_bad_matrices(self):
        v = np.random.default_rng(1).normal(size=(5, 8))
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        s = v @ v.T
        ok = np.ones(5, bool)
        for broken in (s * 1.5, np.triu(s), np.where(np.eye(5, dtype=bool), np.nan, s)):
            with self.assertRaises(bp.UserError):
                bp.validate_similarity(broken, ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
