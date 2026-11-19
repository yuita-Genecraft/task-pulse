# -*- coding: utf-8 -*-
"""progress.js の「#PR番号」と【目的】の変異試験。各変異で tests/progress.cjs の狙いの試験が AssertionError で落ちる事（試験名・断言の本文で確かめる）。
実行：python3 -I tests/mutate_progress_prnum.py"""
import os, re, shutil, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = "PR番号プレフィックスと【目的】の抽出"
MUT = [
  ("no_number", 'title = `#${prReview.pr} ${cleanTitle}`;', 'title = cleanTitle;', TARGET),
  ("number_without_space", 'title = `#${prReview.pr} ${cleanTitle}`;', 'title = `#${prReview.pr}${cleanTitle}`;', TARGET),
  ("number_also_on_no_info", 'title = `PR #${prReview.pr}（題なし）`;', 'title = `#${prReview.pr} PR #${prReview.pr}（題なし）`;', TARGET),
  ("purpose_never_set", 'purpose = m[1].trim();', 'purpose = "開発";', TARGET),
  ("anchor_removed", '/^【([^】]+)】/', '/【([^】]+)】/', TARGET),
  ("empty_allowed_both_guards_off", ['/^【([^】]+)】/', 'if (m && m[1].trim()) {'], ['/^【([^】]*)】/', 'if (m) {'], TARGET),
  ("blank_only_allowed", 'if (m && m[1].trim()) {', 'if (m) {', TARGET),
  ("title_loses_brackets", 'title = `#${prReview.pr} ${cleanTitle}`;', 'title = `#${prReview.pr} ${cleanTitle.replace(/^【[^】]+】\\s*/, "")}`;', TARGET),
  ("parent_purpose_changed", 'purpose: "開発",\n        core: "",\n        desc: "",', 'purpose: "x",\n        core: "",\n        desc: "",', TARGET),
  ("raw_title_used", 'const m = /^【([^】]+)】/.exec(cleanTitle);', 'const m = /^【([^】]+)】/.exec(String(info.title));', TARGET),
]
def run(dirp):
    p = subprocess.run(["node", "--test", "progress.cjs"], cwd=os.path.join(dirp, "tests"), capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr
def main():
    src = open(os.path.join(ROOT, "progress.js"), encoding="utf-8").read()
    bad = 0
    with tempfile.TemporaryDirectory() as d0:
        for f in os.listdir(ROOT):
            if f in (".git", "tests", "node_modules"): continue
            (shutil.copytree if os.path.isdir(os.path.join(ROOT, f)) else shutil.copy)(os.path.join(ROOT, f), os.path.join(d0, f))
        os.makedirs(d0 + "/tests"); shutil.copy(ROOT + "/tests/progress.cjs", d0 + "/tests"); os.symlink(ROOT + "/tests/node_modules", d0 + "/tests/node_modules")
        rc0, out0 = run(d0)
        print("baseline rc=%d（無変異の複製は緑でなければならない）" % rc0)
        if rc0 != 0: print(out0[-600:]); sys.exit(2)
    for name, old, new, want in MUT:
        olds, news = (old, new) if isinstance(old, list) else ([old], [new])
        if any(src.count(o) != 1 for o in olds):
            print("BAD-MUTANT", name, "（置換元が 1 個でない）"); bad += 1; continue
        mutated = src
        for o, n in zip(olds, news): mutated = mutated.replace(o, n)
        with tempfile.TemporaryDirectory() as d:
            for f in os.listdir(ROOT):
                if f in (".git", "tests", "node_modules"): continue
                (shutil.copytree if os.path.isdir(os.path.join(ROOT, f)) else shutil.copy)(os.path.join(ROOT, f), os.path.join(d, f))
            os.makedirs(d + "/tests"); shutil.copy(ROOT + "/tests/progress.cjs", d + "/tests")
            os.symlink(ROOT + "/tests/node_modules", d + "/tests/node_modules")
            open(d + "/progress.js", "w", encoding="utf-8").write(mutated)
            rc, out = run(d)
        failing = re.findall(r"^✖ (.+?) \([\d.]+ms\)$", out, re.M)
        ok = rc != 0 and any(want in t for t in failing) and "AssertionError" in out
        print(("KILLED " if ok else "NOT-KILLED ") + name, "failing=%s" % failing[:3])
        bad += 0 if ok else 1
    print("mutants: total=%d not_killed=%d" % (len(MUT), bad)); sys.exit(1 if bad else 0)
main()
