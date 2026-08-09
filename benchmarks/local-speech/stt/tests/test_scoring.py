from common.scoring import normalize_transcript, score_wer


def test_normalize_transcript_preserves_words_across_case_and_punctuation():
    assert normalize_transcript(" Aurora, STARTS! ") == "aurora starts"


def test_score_wer_counts_substitution_deletion_and_insertion():
    score = score_wer("alpha beta gamma", "alpha delta gamma extra")

    assert score.reference_words == 3
    assert score.substitutions == 1
    assert score.deletions == 0
    assert score.insertions == 1
    assert round(score.wer, 6) == 0.666667
