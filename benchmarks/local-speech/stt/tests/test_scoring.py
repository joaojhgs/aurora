from common.scoring import normalize_transcript, percentile, score_wer


def test_normalize_transcript_preserves_words_across_case_and_punctuation():
    assert normalize_transcript(" Aurora, STARTS! ") == "aurora starts"


def test_score_wer_counts_substitution_deletion_and_insertion():
    score = score_wer("alpha beta gamma", "alpha delta gamma extra")

    assert score.reference_words == 3
    assert score.substitutions == 1
    assert score.deletions == 0
    assert score.insertions == 1
    assert round(score.wer, 6) == 0.666667


def test_percentile_uses_nearest_rank_for_release_gates():
    values = list(range(1, 21))

    assert percentile(values, 0) == 1
    assert percentile(values, 50) == 10
    assert percentile(values, 95) == 19
    assert percentile(values, 100) == 20
    assert percentile([], 95) is None
