"""Consolidate saved matched K3 epochs, retaining failures and epoch strata."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from k1_saved_case_history import distribution, phase_counts

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'thesis/campaigns'
EPOCHS = [
    ('V1481', 'worker-desktop-k3-orca-relayed-http-v1481', 'terminal-v1506/final-artifacts/summary.json', 0, 513),
    ('V1513', 'worker-desktop-k3-orca-relayed-http-remaining-v1513', 'terminal-v1549/final-artifacts/summary.json', 513, 203),
    ('V1620', 'worker-desktop-k3-orca-relayed-http-remaining-v1620', 'terminal-v1637/summary.json', 716, 24),
    ('V1682', 'worker-desktop-k3-orca-relayed-http-remaining-v1682', 'terminal-20261020T0213/summary.json', 740, 160),
]
FIELDS = ['comparisonFamilyId', 'audio', 'candidateManifestSha256', 'models', 'effectiveSetup',
          'effectiveEnvironment', 'sourceClosure', 'runtime', 'runtimeVersions', 'remoteReceivers',
          'remoteAssistantConfigBinding', 'remoteAssistantResponseIdentity', 'remoteConfiguredLlm',
          'remoteSttEndpointSha256', 'remoteAssistantEndpointSha256', 'remoteTtsEndpointSha256',
          'remoteAuthBinding', 'stagePlacement', 'workerHardware', 'transportClassification', 'routeClassification']

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--config-witness', type=Path,
                        help='Reuse the retained config witness for saved-data reproduction; no private config reads')
    args = parser.parse_args()
    output = args.output_dir.resolve()
    assert output.is_relative_to(ROOT / 'thesis') and not output.exists()
    existing = json.loads(args.config_witness.read_text()) if args.config_witness else None
    references, witnesses, groups, combined = [], {}, [], []
    common = None
    for label, folder, summary_name, offset, expected in EPOCHS:
        directory = BASE / folder
        manifest_raw = (directory / 'condition-frozen.json').read_bytes()
        manifest = json.loads(manifest_raw)
        summary_path = directory / summary_name
        summary_raw = summary_path.read_bytes()
        summary = json.loads(summary_raw)
        assert summary['frozen_cohort_manifest_sha256'] == sha(manifest_raw)
        assert summary['measured_requests'] == expected
        assert summary['config_startup_semantics_verified'] is True
        assert set(summary['config_startup_changed_key_paths']) <= {'services.gateway.api.token_secret'}
        projection = {key: manifest[key] for key in FIELDS}
        if common is None:
            common = projection
        assert projection == common, 'Scientific descriptors differ; keep strata separate, do not pool'
        if existing:
            witness = existing[label]
            assert witness['manifestSha256'] == sha(manifest_raw)
            assert witness['summarySha256'] == sha(summary_raw)
        else:
            config_raw = Path(manifest['immutableRuntimeConfigInput']['path']).read_bytes()
            config_sha = sha(config_raw)
            assert config_sha in [manifest['runtimeConfigSha256'], summary['config_raw_sha256_before_startup'], summary['config_raw_sha256_after_startup']]
            config = json.loads(config_raw)
            config['services']['gateway']['api'].pop('token_secret', None)
            witness = {'manifestSha256': sha(manifest_raw), 'summarySha256': sha(summary_raw),
                       'availableConfigWitnessSha256': config_sha,
                       'isPostStartupWitness': config_sha == summary['config_sha256'],
                       'normalizedConfigHash': sha(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()),
                       'normalization': 'Exclude only services.gateway.api.token_secret; no private values copied',
                       'startupChangedPaths': summary['config_startup_changed_key_paths'],
                       'startupSemanticsVerified': True,
                       'scope': 'V1481 available witness is its frozen input; post-startup hash is retained in summary. Others use matched post-startup content.'}
        witnesses[label] = witness
        state = json.loads((directory / 'CURRENT.json').read_text())
        rows = []
        for record in state['completedCases'].values():
            path = ROOT / record['case']
            raw = path.read_bytes()
            assert sha(raw) == record['caseSha256']
            row = json.loads(raw)
            if row['phase'] != 'measured':
                continue
            if 'frozen_cohort_manifest_sha256' in row:
                assert row['frozen_cohort_manifest_sha256'] == sha(manifest_raw)
            local_index = row.get('phase_index', row['ordinal'] - 15)
            global_index = offset + local_index
            assert row.get('condition_measured_index', global_index) == global_index
            rows.append(row)
            combined.append({'epoch': label, 'conditionMeasuredIndex': global_index,
                             'manifestSha256': sha(manifest_raw), 'caseSource': str(path.relative_to(ROOT)),
                             'caseSha256': sha(raw), 'row': row})
        rows.sort(key=lambda row: row['ordinal'])
        assert len(rows) == expected
        assert [row.get('phase_index', row['ordinal'] - 15) for row in rows] == list(range(1, expected + 1))
        correct = [row for row in rows if row['status'] == 'completed_correct']
        assert len(correct) == summary['successful_correct_count']
        metrics = distribution([row['flow_duration_ms'] for row in correct])
        for quantile in ['p50', 'p90', 'p95']:
            assert abs(metrics[quantile + '_ms'] - summary['successful_correct_latency_ms_r7'][quantile]) < 1e-7
        groups.append({'epoch': label, 'firstGlobalIndex': offset + 1, 'lastGlobalIndex': offset + expected,
                       'counts': phase_counts(rows), 'correctOnlyLatencyMs': metrics,
                       'providerManifestSha256': manifest['providerManifestSha256'],
                       'providerReceiver': manifest['providerReceiver']})
        references.extend([{'path': str((directory / 'condition-frozen.json').relative_to(ROOT)), 'sha256': sha(manifest_raw)},
                           {'path': str(summary_path.relative_to(ROOT)), 'sha256': sha(summary_raw)}])
    assert len({item['normalizedConfigHash'] for item in witnesses.values()}) == 1
    combined.sort(key=lambda item: item['conditionMeasuredIndex'])
    assert [item['conditionMeasuredIndex'] for item in combined] == list(range(1, 901))
    assert len({item['row']['harness_case_id'] for item in combined}) == 900
    assert len({item['row']['correlation']['correlation_id'] for item in combined}) == 900
    rows = [item['row'] for item in combined]
    correct = [row for row in rows if row['status'] == 'completed_correct']
    assert len(correct) == 885
    result = {'at': datetime.now(timezone.utc).isoformat(),
              'status': '900_COLLECTED_MATCHED_FOUR_EPOCHS_COMBINED_METRICS_PENDING_SINGLE_BOUNDED_REVIEW',
              'analysisSourceSha256': sha(Path(__file__).read_bytes()),
              'counts': phase_counts(rows), 'correctnessDenominator': 900,
              'failureCodes': dict(Counter(row.get('failure', {}).get('code') for row in rows if row.get('failure'))),
              'partialQualityFailures': sum(row.get('partial_quality_incorrect') is True for row in rows),
              'timeoutFieldAbsent': sum('timeout' not in row for row in rows),
              'correctOnlyLatencyMs': distribution([row['flow_duration_ms'] for row in correct]),
              'epochs': groups, 'references': references,
              'comparability': {'identicalRecordedScientificFields': FIELDS,
                                'normalizedConfigHash': next(iter(witnesses.values()))['normalizedConfigHash'],
                                'normalization': 'Only local auth token excluded; model/settings/source/runtime/route descriptors exact',
                                'operationalChanges': 'Request/process/lifecycle identities and excluded warmups; raw runtime config differences limited to documented local token migration',
                                'providerLifecycles': 'V1481/V1513/V1620 reused original provider; V1682 separate fresh provider after original retirement',
                                'poolingScope': 'Only these matched GPU-provider K3 Orca-relayed HTTP epochs; no CPU, other fixture/model, direct-HTTP, P2P or surface cohorts'},
              'populationPolicy': 'All900 outcomes retained. Latency quantiles condition on885 correct completed valid-audio responses;15 failed/partial attempts are excluded from successful e2e latency, not from outcome denominators. Epoch strata and warmup/setup histories remain separate.',
              'quantileMethod': 'Hyndman-Fan Type7 h=(n-1)*p, linear interpolation; milliseconds; raw rows pooled, never percentile summaries averaged',
              'limitations': 'Four interrupted/continued epochs, not one uninterrupted process. Report cohort strata; no causal inference from provider restart or performance. Model/transport failures preserved; native/resource reports remain separately scoped.',
              'newMeasurements': 0, 'sutCalls': 0}
    output.mkdir(parents=True)
    (output / 'CONFIG-COMPARABILITY-WITNESSES.json').write_bytes(encode(witnesses))
    (output / 'MEASURED-REQUESTS.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in combined))
    (output / 'SUMMARY.json').write_bytes(encode(result))
    print(json.dumps({'summary': str(output / 'SUMMARY.json'), 'counts': result['counts'],
                      'correctOnlyLatencyMs': result['correctOnlyLatencyMs'], 'partialQualityFailures': result['partialQualityFailures']}))

if __name__ == '__main__':
    main()
