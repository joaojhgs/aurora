# Aurora thesis evidence push receipt

**Status: Historical/provenance — verified public citation snapshot, 22 October 2026.**

- Repository: `https://github.com/joaojhgs/aurora`.
- Published branch: `thesis/evidence`.
- Annotated tag: `thesis-evidence`.
- Immutable citation commit: `0bbc171519a3a43b7ce7f01241a6727380470662`.
- Citation URL: [thesis tree at the published commit](https://github.com/joaojhgs/aurora/tree/0bbc171519a3a43b7ce7f01241a6727380470662/thesis).
- Annotated tag object: `98aad365ff67479db7028317f4a8c2eec86ccd43`.
- Public parent commit: `c0f4c0013cea5bb11ef81297194d0dc142a47bc4`, from `origin/codex/aurora-product-review-20261010`.

The citation commit adds exactly the `thesis/` and `docs/experiments/tcc-20261013-submission-20261030/` trees from local evidence commit `7d6967aba14b7476391019e9ab11cfc4e1a53f1c`. Both recursive tree listings, every file mode and every blob hash match that local snapshot. It changes no workflows or product source and inherits no unpublished campaign ancestry. The original memory-backed clone and all raw originals remain intact.

The **455 local source commits in the ancestry of `7d6967aba14b7476391019e9ab11cfc4e1a53f1c` remain pending a workflow-scoped push**. GitHub rejected their previous publication because the available token could not update `.github/workflows/python-tests.yml`. The exact copied evidence retains its original historical metadata: `EVIDENCE-ANCESTRY.txt` inventories those pending source commits, and older publication notes refer to the attempted `thesis/evidence-20261022` branch. Those records are not a claim that the source ancestry was published. This receipt clarifies the actual public branch and ancestry without editing the preserved evidence.

The tagged snapshot contains **28,636 added files / 650,076,081 bytes**:

| Scope | Files | Bytes |
| --- | ---: | ---: |
| `thesis/` | 27,103 | 603,406,645 |
| `docs/experiments/tcc-20261013-submission-20261030/` | 1,533 | 46,669,436 |

These totals include 28,617 original evidence files and 19 publication metadata files. The largest added file is 8,353,252 bytes. This follow-up receipt is additional to the tagged snapshot; the tag remains on the citation commit above.

[Exact exclusions and pending paths](EVIDENCE-EXCLUSIONS.json), [large-file exclusions](EXCLUDED-LARGE-FILES.json), and the [complete worker hash inventory](EVIDENCE-INVENTORY/INDEX.json) remain unchanged. The inventory covers 68,289 worker files / 2,802,248,499 bytes, including withheld raw data. Exclusions include 13 credential-like files/copies, 274 regenerable caches, 20 files over 10 MB, and raw audio, logs, prefixes, archives and encoded payloads.

Pending active/recent paths include `thesis/analysis/paris-lifecycle-audit-20261022/`, `thesis/analysis/coding-harness-repair-six-cell-scan-20261022.json`, `docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md`, and `thesis/evidence/orca-relayed-http-v1197/reports-v1234/root/CURRENT.md`. Personal-desktop inventory/copy, the remaining source-ancestry secret review and the raw-data GitHub Release remain deferred. No raw originals were deleted or modified; no tests or measurements were run.

Origin verification completed after both pushes: `git ls-remote` returned the branch commit and the annotated tag object with the peeled citation SHA above; the tag was fetched from origin into `refs/verification/thesis-evidence`; `git cat-file -t` confirmed an annotated tag; and `git ls-tree` confirmed these published trees:

```text
9a6f37839f9ee855811515d799801a98de1d24de  thesis
e39c5fa4b7f3bc07bd83154e3877e8d06797b927  docs/experiments/tcc-20261013-submission-20261030
```
