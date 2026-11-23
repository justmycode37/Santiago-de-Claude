// AR core (src/arcore.ts): the decisions behind the AR camera, shared with Node tests and (later) the iOS app.

/** [x, y, width, height] in the picture, normalised 0–1, top-left origin. */
type ArBox = [number, number, number, number];
/** One piece of text OCR read: what, where, how sure (0–1). */
interface ArText { text: string; box: ArBox; score: number }
/** Where a vehicle (or, on the web, the aim frame around its display) is in the picture; score: the detector's, 1 for the aim frame. */
interface ArDetection { box: ArBox; score: number }

/** A service that can stop here soon: the ride you want, or another departure of the stop. */
interface ArCandidate { line: string; destination: string; vias?: string[]; isExpected?: boolean }
type ArLineEvidence = 'exact' | 'confusable' | 'unseen' | 'contradicted';
interface ArCandidateScore {
  candidate: ArCandidate;
  /** 0–1: how well the best display row fits the destination (or a via). */
  destination: number;
  line: ArLineEvidence;
  /** The text that gave `destination`. */
  observed: string;
  ocrScore: number;
  /** 0–1 from live vehicle positions; 0 when unknown. */
  position: number;
  total: number;
}
type ArMatchOutcome = 'matched' | 'ambiguous' | 'unlisted' | 'unreadable';
interface ArBoardMatch {
  outcome: ArMatchOutcome;
  best: ArCandidateScore | null;
  runnerUp: ArCandidateScore | null;
  margin: number;
  /** How far this one frame can be trusted, 0–1. */
  confidence: number;
}

/** What one frame shows on one vehicle. at: seconds. */
interface ArReading {
  frameId: string;
  at: number;
  line: string | null;
  destination: string | null;
  outOfService: boolean;
  ambiguous: boolean;
  raw: string[];
  observed: ArText[];
  /** 0.56–1: how far a reading from this frame can be trusted on image grounds. */
  frameQuality: number;
}

/** The ride you want, and what else can stop here (the board), for the vehicle decision. */
interface ArExpectation {
  line: string;
  destination: string;
  vias?: string[];
  /** Other services due at the stop: a misread is then not taken for a wrong vehicle, and a wrong one can be named. */
  board?: ArCandidate[];
  /** The ride's stops before where you get off: the same line showing one of them is a short working. */
  stopsBefore?: string[];
}
type ArDecisionState = 'unknown' | 'wrong' | 'match';
type ArBasis = 'consensus' | 'best_single_frame';
interface ArDecision {
  state: ArDecisionState;
  reason: string;
  /** The other service the display shows (state 'wrong'). */
  other?: ArCandidate;
  observed?: string;
  basis?: ArBasis | null;
  confidence?: number | null;
}

