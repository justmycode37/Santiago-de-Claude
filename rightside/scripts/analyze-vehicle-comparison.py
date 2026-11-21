#!/usr/bin/env python3
"""Validate and summarize a frozen phone comparison. No app/model inference."""
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

POLICY_CHECKS = {
    'right_route_pair', 'left_route_pair', 'duplicate_rows', 'other_vehicle_veto',
    'separate_row_veto', 'weak_route_not_promoted', 'conflicting_pairs',
    'number_at_both_ends_abstains', 'printed_number_only', 'route_engine_agreement',
    'route_engine_low_character_veto', 'route_engine_disagreement_veto',
    'route_engine_cross_track_veto', 'route_engine_correlated_conflict',
    'single_frame_never_candidate', 'wrong_service_rejected',
    'street_suffix_cannot_create_route', 'street_suffix_with_separate_route',
    'adaptive_preserves_camera_sampling', 'adaptive_preserves_large_source_detail',
    'right_headsign_weak_character_veto',
}
VARIANTS = ['baseline', 'bounded-layout', 'bounded-layout-route-engine']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def metrics(rows):
    readable = [r for r in rows if r['destinationStatus'] == 'readable']
    return {'frames': len(rows), 'detected': sum(r['detected'] for r in rows),
            'labelledCompleteDisplays': len(readable), 'correct': sum(r['readingCorrect'] for r in readable),
            'incorrectComplete': sum(r['incorrectComplete'] for r in rows),
            'unsupportedComplete': sum(r['unsupportedComplete'] for r in rows),
            'unscoredCompleteIDs': [r['id'] for r in rows if r['destinationStatus'] == 'unscored' and r['complete']],
            'wrongServiceFalseCandidates': sum(r['wrongServiceDecision'] in ['visualCandidate', 'verifiedService'] for r in rows),
            'singleFrameFalseCandidates': sum(r['singleFrameDecision'] in ['visualCandidate', 'verifiedService'] for r in rows)}


def summarize(report, delivery, contract, regression_photos):
    require(report.get('status') == 'completed', 'Incomplete phone run')
    require(report.get('executableSHA256') == delivery['executableSHA256'], 'Wrong installed binary')
    comparison = report['vehicleV2']
    require(comparison['manifestSHA256'] == delivery['fixtureSHA256'], 'Wrong frozen media contract')
    if 'reserveFixtureSHA256' in delivery:
        require(comparison.get('reserveManifestSHA256') == delivery['reserveFixtureSHA256'], 'Wrong reserved encounter')
    variants = comparison['variants']
    require([v['name'] for v in variants] == VARIANTS, 'Missing or unexpected candidate')
    checks = comparison['policyChecks']
    names = [c['name'] for c in checks]
    require(len(names) == len(set(names)) and POLICY_CHECKS <= set(names), 'Missing/duplicate policy checks')
    require(all(type(c.get('passed')) is bool for c in checks), 'Invalid policy result')
    lifecycle = report['evidenceLifecycle']
    require(len(lifecycle) >= 11 and len({c['name'] for c in lifecycle}) == len(lifecycle), 'Missing/duplicate lifecycle checks')
    require(all(type(c.get('passed')) is bool for c in lifecycle), 'Invalid lifecycle result')
    expected = {p['id']: p for p in contract['photos']}
    for p in regression_photos:
        expected[p['id']] = dict(p, destinationStatus='readable', split='existing-development')
    summary = {'fixtureSHA256': comparison['manifestSHA256'], 'executableSHA256': report['executableSHA256'],
               'variants': [], 'scope': comparison['scope'], 'sampling': comparison['sampling'],
               'policyPassed': all(c['passed'] for c in checks), 'policyChecks': checks,
               'lifecyclePassed': all(c['passed'] for c in lifecycle), 'journeyPassed': report['journey'].get('passed') is True}
    for variant in variants:
        rows = variant['photos']
        ids = [r['id'] for r in rows]
        require(len(ids) == len(set(ids)) and set(ids) == set(expected), 'Missing/duplicate photo rows')
        for row in rows:
            label = expected[row['id']]
            require(row['split'] == label['split'] and row['destinationStatus'] == label['destinationStatus']
                    and row['expectedLine'] == label['line'] and row['expectedDestination'] == (label.get('destination') or ''),
                    'Report labels differ from frozen contract')
            require(isinstance(row['latencyMS'], (int, float)) and math.isfinite(row['latencyMS']) and row['latencyMS'] >= 0,
                    'Invalid processing time')
            for key in ['detected', 'readingCorrect', 'incorrectComplete', 'unsupportedComplete', 'complete', 'coldPipeline']:
                require(type(row[key]) is bool, 'Invalid photo result type')
            require(row['complete'] == bool(row['observedLine'] and row['observedDestination']), 'Inconsistent complete reading')
            require(not row['readingCorrect'] or (row['complete'] and row['detected'] and row['destinationStatus'] == 'readable'), 'Unsupported success flag')
            require(row['incorrectComplete'] == (row['destinationStatus'] == 'readable' and row['complete'] and not row['readingCorrect']), 'Inconsistent error flag')
            require(row['unsupportedComplete'] == (row['destinationStatus'] == 'absent' and row['complete']), 'Inconsistent unsupported flag')
        require(sum(r['coldPipeline'] for r in rows) == 1, 'Cold timing must remain separate')
        warm = sorted(r['latencyMS'] for r in rows if not r['coldPipeline'])
        negative = report['video'] if variant['name'] == 'baseline' else variant['negativeVideo']
        for key in ['totalFrames', 'droppedFrames', 'unsupportedCompleteReadings', 'falseServiceCandidates']:
            require(type(negative[key]) is int and negative[key] >= 0, 'Invalid negative video result')
        require(negative['totalFrames'] == 48 and negative['droppedFrames'] <= 48, 'Incomplete negative video')
        positive = variant['positiveVideo']
        require(positive['manifestSHA256'] == delivery['temporalFixtureSHA256'] and positive['sourceSHA256'] == delivery['temporalSourceSHA256'], 'Wrong positive recording')
        require(positive['totalFrames'] == 80 and positive['annotatedFrames'] == 6, 'Incomplete positive video')
        for key in ['droppedFrames', 'annotatedDetected', 'annotatedCorrectReadings', 'annotatedIncorrectCompleteReadings', 'annotatedDropped', 'publishedCandidateFrames', 'wrongServiceCandidates', 'unsupportedVerifiedService']:
            require(type(positive[key]) is int and positive[key] >= 0, 'Invalid positive video counter')
        frames = positive['frames']
        require(len(frames) == 80 and [f['index'] for f in frames] == list(range(80)), 'Missing/duplicate temporal frames')
        require(all(type(f['droppedBusy']) is bool and math.isfinite(f['sourcePTS']) for f in frames), 'Invalid temporal frame')
        require(all(a['sourcePTS'] < b['sourcePTS'] for a,b in zip(frames,frames[1:])), 'Non-monotonic source PTS')
        require(sum(f['droppedBusy'] for f in frames) == positive['droppedFrames'], 'Inconsistent busy-drop count')
        require(positive['publishedCandidateFrames'] <= 80-positive['droppedFrames'], 'Invalid candidate count')
        require(type(positive['clearedAfterClockExpiry']) is bool and type(positive['hadCandidateAtEnd']) is bool, 'Invalid expiry result')
        positive_summary = {k:positive[k] for k in ['totalFrames', 'droppedFrames', 'annotatedFrames', 'annotatedDetected', 'annotatedCorrectReadings', 'annotatedIncorrectCompleteReadings', 'annotatedDropped', 'publishedCandidateFrames', 'firstAnyCandidateSourcePTS', 'wrongServiceCandidates', 'unsupportedVerifiedService', 'hadCandidateAtEnd', 'clearedAfterClockExpiry']}
        summary['variants'].append({'name': variant['name'], 'all': metrics(rows),
            'splits': {split: metrics([r for r in rows if r['split'] == split])
                       for split in ['development', 'heldout-encounter', 'existing-development', 'fresh-heldout-encounter']},
            'positiveVideo': positive_summary,
            'warmInferenceMedianMS': statistics.median(warm),
            'warmInferenceP95MS': warm[math.ceil(len(warm) * .95) - 1],
            'coldInferenceMS': [r['latencyMS'] for r in rows if r['coldPipeline']],
            'negativeVideo': {k: negative[k] for k in ['totalFrames', 'droppedFrames', 'unsupportedCompleteReadings', 'falseServiceCandidates']},
            'failures': [{k: r[k] for k in ['id', 'split', 'detected', 'destinationStatus', 'expectedLine', 'expectedDestination', 'observedLine', 'observedDestination']}
                         for r in rows if r['destinationStatus'] == 'readable' and not r['readingCorrect']]})
    base = summary['variants'][0]
    baseline_rows = {r['id']: r for r in variants[0]['photos']}
    for candidate, raw in zip(summary['variants'][1:], variants[1:]):
        candidate['regressedCorrectReadingIDs'] = [r['id'] for r in raw['photos']
            if baseline_rows[r['id']]['readingCorrect'] and not r['readingCorrect']]
        candidate['gainedCorrectReadingIDs'] = [r['id'] for r in raw['photos']
            if not baseline_rows[r['id']]['readingCorrect'] and r['readingCorrect']]
        candidate['supportedGainPendingManualReview'] = (
            bool(candidate['gainedCorrectReadingIDs']) and not candidate['regressedCorrectReadingIDs']
            and candidate['all']['incorrectComplete'] == 0 and candidate['all']['unsupportedComplete'] == 0
            and candidate['all']['singleFrameFalseCandidates'] == 0 and candidate['all']['wrongServiceFalseCandidates'] == 0
            and candidate['negativeVideo']['unsupportedCompleteReadings'] == 0
            and candidate['negativeVideo']['falseServiceCandidates'] == 0
            and candidate['negativeVideo']['droppedFrames'] <= base['negativeVideo']['droppedFrames']
            and candidate['positiveVideo']['annotatedIncorrectCompleteReadings'] == 0
            and candidate['positiveVideo']['wrongServiceCandidates'] == 0 and candidate['positiveVideo']['unsupportedVerifiedService'] == 0
            and candidate['positiveVideo']['clearedAfterClockExpiry']
            and candidate['positiveVideo']['annotatedCorrectReadings'] >= base['positiveVideo']['annotatedCorrectReadings']
            and candidate['positiveVideo']['publishedCandidateFrames'] >= base['positiveVideo']['publishedCandidateFrames']
            and candidate['positiveVideo']['droppedFrames'] <= base['positiveVideo']['droppedFrames']
            and summary['policyPassed'] and summary['lifecyclePassed'] and summary['journeyPassed'])
    summary['decisionNote'] = ('Eligibility is not automatic promotion. Review unscored complete outputs, heldout distribution and latency. '
        'Lost baseline successes and extra busy drops block eligibility. One actual positive video encounter supplements the stills; it does not establish field accuracy or geographic AR guidance.')
    return summary


def main():
    root = Path(__file__).resolve().parents[1]
    report_path = Path(sys.argv[1]).resolve()
    report = json.loads(report_path.read_text())
    delivery = json.loads((root / 'dist/ios/vehicle-v2/delivery.json').read_text())
    contract = json.loads((root / 'redesign/evaluation/vehicle-v2/frozen-contract.json').read_text())
    regression = json.loads((root / 'dist/ios/indoor-lab/IndoorLab/manifest.json').read_text())
    reserve = json.loads((root / 'redesign/evaluation/vehicle-v3/reserve-manifest.json').read_text())
    contract['photos'] += reserve['photos']
    require(report['manifestSHA256'] == hashlib.sha256((root / 'dist/ios/indoor-lab/IndoorLab/manifest.json').read_bytes()).hexdigest(), 'Wrong base fixture')
    summary = summarize(report, delivery, contract, regression['photos'])
    summary.update(report=str(report_path), reportSHA256=hashlib.sha256(report_path.read_bytes()).hexdigest())
    out = report_path.parent / 'vehicle-comparison-summary.json'
    out.write_text(json.dumps(summary, indent=2) + '\n')
    print(out)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
