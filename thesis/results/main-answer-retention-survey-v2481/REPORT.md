# Main saved-answer retention survey

This is a field-coverage survey, not a new correctness analysis or experiment.

The current epoch has304 saved case headers per stream (289 measured plus15 excluded warmups). All608 retain an assistant answer hash; none of the inspected assistant headers retain a plaintext answer field.

That limited finding does not establish all-copy loss. Exact semantic rescoring needs an authoritative predicate and recoverable actual answers. Hashes alone cannot recreate them. Original strict-correct labels, verified stage/audio evidence and the549/900 retained condition counts remain unchanged.

The six historical Main closure summaries are indexed with their existing reported outcomes. Their raw answer coverage is not inferred from summary metadata. Previously skipped TTS or missing audio cannot become a completed full-audio request merely because an answer contains a city name.

Reproduce with the existing Python3.11 environment and this script's --output option pointing to a new directory under thesis/results. No model, service, archive extraction, network test or old request replay occurs. SUMMARY.json records source and ordered input hashes.
