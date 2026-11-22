# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mizuseii/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mizuseii/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

A [make.fun](https://make.fun) bounty entry: `mend`, a command-line tool that
applies AI-written edits in four formats — unified diffs (often with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool
calls — to a tree of text files, changing every file or none.

`main.ts` (Node 22, standard library only) reads a patch from a file or
standard input, detects its format (or takes `--format`), finds the lines each
edit names at the first of three matching tiers — exact, then trailing
whitespace, then leading and trailing whitespace — and writes every change or
none. It handles drifted whitespace and indentation, blank context lines
without their leading space, prose and code fences around the patch, CRLF
files, files without a final line break, creates, deletes, moves and renames,
and blocks that occur twice. A strict applier is the house baseline: this
entry beats it by matching where the model drifted.

Usage:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`--format` is `auto` (the default), `unified`, `search-replace`, `v4a` or
`json`; `--check` reports what would change without writing; `--strict`
matches lines exactly. Exit 0 lists the changed files, exit 1 lists the edits
that failed, exit 2 is a usage, patch, or format error.

Practice score 1000: 100 of 100 checks on the kit's public practice set
(`node check.ts ../program/generator/practice.json` from the kit).
