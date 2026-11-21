"""Report-validator tests on deliberately synthetic dictionaries; never app/vision evidence."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('report_analyzer', Path(__file__).resolve().parents[1] / 'analyze-vehicle-comparison.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ReportValidation(unittest.TestCase):
    def setUp(self):
        self.delivery = {'executableSHA256': 'synthetic-binary', 'fixtureSHA256': 'synthetic-fixture', 'temporalFixtureSHA256': 'synthetic-video', 'temporalSourceSHA256': 'synthetic-source'}
        self.contract = {'photos': [dict(id=str(i), split='development', destinationStatus='readable', line='12', destination='Terminus') for i in range(3)]}
        rows = [dict(p, expectedLine='12', expectedDestination='Terminus', observedLine='', observedDestination='',
                     detected=True, complete=False, readingCorrect=False, incorrectComplete=False, unsupportedComplete=False,
                     coldPipeline=i == 0, latencyMS=10, wrongServiceDecision='unknown', singleFrameDecision='unknown')
                for i,p in enumerate(self.contract['photos'])]
        negative = dict(totalFrames=48, droppedFrames=0, unsupportedCompleteReadings=0, falseServiceCandidates=0)
        positive = dict(manifestSHA256='synthetic-video', sourceSHA256='synthetic-source', totalFrames=80,
            annotatedFrames=6, droppedFrames=0, annotatedDetected=6, annotatedCorrectReadings=0,
            annotatedIncorrectCompleteReadings=0, annotatedDropped=0, publishedCandidateFrames=0,
            firstAnyCandidateSourcePTS=None, wrongServiceCandidates=0, unsupportedVerifiedService=0,
            hadCandidateAtEnd=False, clearedAfterClockExpiry=True,
            frames=[dict(index=i, droppedBusy=False, sourcePTS=24+i/4) for i in range(80)])
        self.report = dict(status='completed', executableSHA256='synthetic-binary', video=negative,
            evidenceLifecycle=[dict(name=str(i), passed=True) for i in range(11)], journey=dict(passed=True),
            vehicleV2=dict(manifestSHA256='synthetic-fixture', scope='SYNTHETIC VALIDATOR TEST', sampling='No media',
                policyChecks=[dict(name=n, passed=True) for n in sorted(m.POLICY_CHECKS)],
                variants=[dict(name=n, photos=copy.deepcopy(rows), negativeVideo=copy.deepcopy(negative), positiveVideo=copy.deepcopy(positive)) for n in m.VARIANTS]))
    def result(self): return m.summarize(self.report, self.delivery, self.contract, [])
    def success(self, variant, i):
        self.report['vehicleV2']['variants'][variant]['photos'][i].update(observedLine='12', observedDestination='terminus', complete=True, readingCorrect=True)
    def test_gain_can_be_eligible_but_is_never_automatic_promotion(self):
        self.success(1,0)
        self.assertTrue(self.result()['variants'][1]['supportedGainPendingManualReview'])
        self.assertIn('not automatic promotion', self.result()['decisionNote'])
    def test_aggregate_gain_cannot_hide_regression(self):
        self.success(0,0); self.success(1,1); self.success(1,2)
        r=self.result()['variants'][1]
        self.assertEqual(r['regressedCorrectReadingIDs'],['0'])
        self.assertFalse(r['supportedGainPendingManualReview'])
    def test_empty_policy_checks_rejected(self):
        self.report['vehicleV2']['policyChecks']=[]
        with self.assertRaisesRegex(ValueError,'policy checks'): self.result()
    def test_duplicate_rows_rejected(self):
        self.report['vehicleV2']['variants'][1]['photos'][1]=copy.deepcopy(self.report['vehicleV2']['variants'][1]['photos'][0])
        with self.assertRaisesRegex(ValueError,'photo rows'): self.result()
    def test_wrong_binary_and_contract_rejected(self):
        for key in ['executableSHA256','fixtureSHA256']:
            original=self.delivery[key];self.delivery[key]='wrong'
            with self.assertRaises(ValueError):self.result()
            self.delivery[key]=original
    def test_nonfinite_latency_rejected(self):
        self.report['vehicleV2']['variants'][1]['photos'][0]['latencyMS']=float('nan')
        with self.assertRaisesRegex(ValueError,'processing time'):self.result()
    def test_label_drift_rejected(self):
        self.report['vehicleV2']['variants'][1]['photos'][0]['expectedLine']='99'
        with self.assertRaisesRegex(ValueError,'frozen contract'):self.result()
    def test_missing_candidate_video_cannot_fall_back_to_baseline(self):
        del self.report['vehicleV2']['variants'][1]['negativeVideo']
        with self.assertRaises(KeyError):self.result()
    def test_extra_drops_block_eligibility(self):
        self.success(1,0); self.report['vehicleV2']['variants'][1]['negativeVideo']['droppedFrames']=1
        self.assertFalse(self.result()['variants'][1]['supportedGainPendingManualReview'])
    def test_false_candidate_blocks_eligibility(self):
        self.success(1,0); self.report['vehicleV2']['variants'][1]['photos'][0]['singleFrameDecision']='visualCandidate'
        self.assertFalse(self.result()['variants'][1]['supportedGainPendingManualReview'])
    def test_success_without_observed_reading_rejected(self):
        self.report['vehicleV2']['variants'][1]['photos'][0]['readingCorrect']=True
        with self.assertRaisesRegex(ValueError,'Unsupported success'):self.result()

    def test_temporal_confirmation_cannot_be_manufactured(self):
        self.success(1,0)
        self.report['vehicleV2']['variants'][1]['positiveVideo']['unsupportedVerifiedService']=1
        self.assertFalse(self.result()['variants'][1]['supportedGainPendingManualReview'])
    def test_temporal_regression_blocks_eligibility(self):
        self.success(1,0)
        self.report['vehicleV2']['variants'][0]['positiveVideo']['publishedCandidateFrames']=1
        self.assertFalse(self.result()['variants'][1]['supportedGainPendingManualReview'])
    def test_missing_temporal_frame_rejected(self):
        self.report['vehicleV2']['variants'][1]['positiveVideo']['frames'].pop()
        with self.assertRaisesRegex(ValueError,'temporal frames'):self.result()
    def test_duplicate_source_time_rejected(self):
        frames=self.report['vehicleV2']['variants'][1]['positiveVideo']['frames'];frames[1]['sourcePTS']=frames[0]['sourcePTS']
        with self.assertRaisesRegex(ValueError,'source PTS'):self.result()

if __name__ == '__main__': unittest.main()
