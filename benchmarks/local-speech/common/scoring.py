"""Deterministic speech-recognition scoring helpers."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from math import ceil

_WORD_RE = re.compile(r"[\w']+", re.UNICODE)


@dataclass(frozen=True)
class WerScore:
    """Word-error-rate summary for one transcript comparison."""

    reference_words: int
    substitutions: int
    deletions: int
    insertions: int

    @property
    def errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions

    @property
    def wer(self) -> float:
        if self.reference_words == 0:
            return 0.0 if self.errors == 0 else 1.0
        return self.errors / self.reference_words


def normalize_transcript(text: str) -> str:
    """Normalize text for benchmark scoring without changing language identity."""

    normalized = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(_WORD_RE.findall(normalized))


def tokenize_transcript(text: str) -> list[str]:
    """Return normalized word tokens used for WER calculation."""

    normalized = normalize_transcript(text)
    if not normalized:
        return []
    return normalized.split(" ")


def score_wer(reference: str, hypothesis: str) -> WerScore:
    """Compute WER with substitution/deletion/insertion counts."""

    ref = tokenize_transcript(reference)
    hyp = tokenize_transcript(hypothesis)
    rows = len(ref) + 1
    cols = len(hyp) + 1
    # Each cell stores (cost, substitutions, deletions, insertions).
    dp: list[list[tuple[int, int, int, int]]] = [
        [(0, 0, 0, 0) for _ in range(cols)] for _ in range(rows)
    ]
    for i in range(1, rows):
        cost, subs, dels, ins = dp[i - 1][0]
        dp[i][0] = (cost + 1, subs, dels + 1, ins)
    for j in range(1, cols):
        cost, subs, dels, ins = dp[0][j - 1]
        dp[0][j] = (cost + 1, subs, dels, ins + 1)

    for i in range(1, rows):
        for j in range(1, cols):
            if ref[i - 1] == hyp[j - 1]:
                candidates = [dp[i - 1][j - 1]]
            else:
                cost, subs, dels, ins = dp[i - 1][j - 1]
                candidates = [(cost + 1, subs + 1, dels, ins)]

            cost, subs, dels, ins = dp[i - 1][j]
            candidates.append((cost + 1, subs, dels + 1, ins))

            cost, subs, dels, ins = dp[i][j - 1]
            candidates.append((cost + 1, subs, dels, ins + 1))
            dp[i][j] = min(candidates, key=lambda item: (item[0], item[2], item[3], item[1]))

    _cost, substitutions, deletions, insertions = dp[-1][-1]
    return WerScore(
        reference_words=len(ref),
        substitutions=substitutions,
        deletions=deletions,
        insertions=insertions,
    )


def percentile(values: list[float], pct: float) -> float | None:
    """Nearest-rank percentile for deterministic benchmark summaries."""

    if not values:
        return None
    if pct <= 0:
        return min(values)
    if pct >= 100:
        return max(values)
    ordered = sorted(values)
    rank = ceil((pct / 100.0) * len(ordered)) - 1
    return ordered[max(0, min(rank, len(ordered) - 1))]
