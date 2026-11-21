"use strict";
var RightSideBridge = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target2, all) => {
    for (var name in all)
      __defProp(target2, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/ios-bridge/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    call: () => call2
  });

  // packages/contracts/src/index.ts
  var CAPABILITY_NAMES = ["journeySearch", "placeSearch", "departureBoard", "tripDetail", "liveTimes", "liveQuayChanges", "disruptions", "walkGeometry", "walkInstructions", "levelAwareWalking", "accessibility", "vehiclePositions", "fares"];
  var ContractValidationError = class extends Error {
    constructor(issues) {
      super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
      this.issues = issues;
      this.name = "ContractValidationError";
    }
    issues;
  };
  var fail = (issues, path, message) => {
    issues.push({ path, message });
  };
  var str = (v, p, i) => {
    if (typeof v !== "string" || !v.trim()) fail(i, p, "Expected nonempty string");
  };
  var bool = (v, p, i) => {
    if (typeof v !== "boolean") fail(i, p, "Expected boolean");
  };
  var number = (min = -Infinity, max = Infinity, integer2 = false) => (v, p, i) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || integer2 && !Number.isInteger(v)) fail(i, p, `Expected ${integer2 ? "integer" : "number"} in [${min}, ${max}]`);
  };
  var nonnegative = number(0);
  var integer = number(0, Number.MAX_SAFE_INTEGER, true);
  var one = (...values) => (v, p, i) => {
    if (!values.includes(v)) fail(i, p, `Expected one of ${values.join(", ")}`);
  };
  var nullable = (c) => (v, p, i) => {
    if (v !== null) c(v, p, i);
  };
  var optional = (c) => (v, p, i) => {
    if (v !== void 0) c(v, p, i);
  };
  var array = (c, min = 0) => (v, p, i) => {
    if (!Array.isArray(v)) return fail(i, p, "Expected array");
    if (v.length < min) fail(i, p, `Expected at least ${min} items`);
    v.forEach((item, index) => c(item, `${p}[${index}]`, i));
  };
  var object = (shape) => (v, p, i) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail(i, p, "Expected object");
    for (const [key, c] of Object.entries(shape)) c(v[key], `${p}.${key}`, i);
  };
  var date = (v, p, i) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail(i, p, "Expected valid YYYY-MM-DD date");
  };
  var instant = (v, p, i) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v) || !Number.isFinite(Date.parse(v))) return fail(i, p, "Expected ISO instant with timezone offset");
    date(v.slice(0, 10), p, i);
  };
  var coordinate = (v, p, i) => {
    if (!Array.isArray(v) || v.length !== 2) return fail(i, p, "Expected [longitude, latitude]");
    number(-180, 180)(v[0], `${p}[0]`, i);
    number(-90, 90)(v[1], `${p}[1]`, i);
  };
  function refine(check, semantic) {
    return (v, p, i) => {
      const before = i.length;
      check(v, p, i);
      if (i.length === before) semantic(v, p, i);
    };
  }
  function schema(check) {
    return {
      parse(value) {
        const result = this.safeParse(value);
        if (!result.success) throw new ContractValidationError(result.issues);
        return result.data;
      },
      safeParse(value) {
        const issues = [];
        check(value, "$", issues);
        return issues.length ? { success: false, issues } : { success: true, data: value };
      }
    };
  }
  var orderedTimes = (start, end, p, i) => {
    if (start && end && Date.parse(start) > Date.parse(end)) fail(i, p, "End precedes start");
  };
  var unique = (values, p, i) => {
    if (new Set(values).size !== values.length) fail(i, p, "Duplicate IDs");
  };
  var evidence = refine(object({ source: str, sourceVersion: optional(str), fetchedAt: instant, observedAt: optional(instant), validFrom: optional(instant), validUntil: optional(instant), kind: one("observed", "predicted", "scheduled", "interpolated", "derived", "manual", "replay", "simulated"), quality: one("verified", "supported", "ambiguous", "unknown") }), (v, p, i) => orderedTimes(v.validFrom, v.validUntil, p, i));
  var evidenceList = array(evidence, 1);
  var sourceRef = object({ provider: str, id: str, feedVersion: nullable(str) });
  var place = object({ id: str, name: str, kind: one("address", "stop", "entrance", "coordinate", "poi", "unknown"), coordinate: nullable(coordinate), parentId: nullable(str), sourceRefs: array(sourceRef), evidence: evidenceList });
  var frequencyWindow = refine(object({ startOffsetSeconds: integer, endOffsetSeconds: integer, headwaySeconds: number(1, Number.MAX_SAFE_INTEGER, true), exactTimes: bool }), (v, p, i) => {
    if (v.endOffsetSeconds <= v.startOffsetSeconds) fail(i, p, "Frequency end must follow start");
  });
  var trip = object({ provider: str, feedVersion: nullable(str), sourceTripId: nullable(str), sjyid: nullable(str), operatingDate: date, tripStartOffsetSeconds: nullable(integer), timezone: str, frequencyWindow: nullable(frequencyWindow) });
  var assignment = refine(object({ status: one("resolved_live", "resolved_planned", "manually_verified", "candidates_only", "stop_only", "conflicting", "unavailable"), sourceRef: nullable(sourceRef), originalLabel: nullable(str), label: nullable(str), candidates: array(str), conflictReason: nullable(str), evidence: evidenceList }), (v, p, i) => {
    if (v.status === "conflicting" && !v.conflictReason) fail(i, p, "Conflicting assignment needs a reason");
  });
  var pedestrianArea = refine(object({ kind: one("point", "polygon"), coordinates: array(coordinate, 1), level: nullable(str), evidence: evidenceList }), (v, p, i) => {
    if (v.kind === "point" && v.coordinates.length !== 1) fail(i, p, "Point requires one coordinate");
    if (v.kind === "polygon" && (v.coordinates.length < 4 || JSON.stringify(v.coordinates[0]) !== JSON.stringify(v.coordinates.at(-1)))) fail(i, p, "Polygon requires a closed ring of at least four coordinates");
  });
  var target = refine(object({ id: str, callId: str, assignment, transitCoordinate: nullable(coordinate), pedestrianArea: nullable(pedestrianArea), pedestrianTargetStatus: one("verified_area", "inferred_area", "unverified", "unavailable"), approachEntrance: nullable(place), level: nullable(str), precisionMeters: nullable(nonnegative), evidence: evidenceList }), (v, p, i) => {
    if (["verified_area", "inferred_area"].includes(v.pedestrianTargetStatus) && !v.pedestrianArea) fail(i, p, "Resolved pedestrian status needs an area");
    if (v.pedestrianTargetStatus === "unavailable" && v.pedestrianArea !== null) fail(i, p, "Unavailable area must be null");
  });
  var call = refine(object({ id: str, trip, stopSequence: nullable(integer), place, plannedArrival: nullable(instant), plannedDeparture: nullable(instant), expectedArrival: nullable(instant), expectedDeparture: nullable(instant), plannedAssignment: assignment, currentAssignment: assignment, pickup: one("allowed", "forbidden", "request", "unknown"), dropoff: one("allowed", "forbidden", "request", "unknown"), status: one("scheduled", "cancelled", "skipped", "unknown"), evidence: evidenceList }), (v, p, i) => {
    orderedTimes(v.plannedArrival, v.plannedDeparture, p, i);
    orderedTimes(v.expectedArrival, v.expectedDeparture, p, i);
  });
  var geometry = object({ type: one("LineString"), coordinates: array(coordinate, 2), quality: one("routed", "surveyed", "schematic", "unknown"), evidence: evidenceList });
  var instruction = object({ id: str, text: str, coordinate: nullable(coordinate), kind: one("walk", "crossing", "stairs", "lift", "wait", "board", "alight", "arrive", "unknown") });
  var preferences = object({ stepFree: bool, maxWalkMeters: nullable(nonnegative), language: str });
  var baseLeg = { id: str, from: place, to: place, plannedStart: instant, plannedEnd: instant, expectedStart: nullable(instant), expectedEnd: nullable(instant), geometry: nullable(geometry), instructions: array(instruction), accessibility: one("yes", "no", "unknown"), evidence: evidenceList };
  function discriminated(key, branches) {
    return (v, p, i) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return fail(i, p, "Expected object");
      const discriminator = v[key];
      if (typeof discriminator !== "string" || !Object.hasOwn(branches, discriminator)) return fail(i, `${p}.${key}`, `Unknown ${key}`);
      branches[discriminator](v, p, i);
    };
  }
  function sameTripOccurrence(a, b) {
    return a.provider === b.provider && a.feedVersion === b.feedVersion && a.sourceTripId === b.sourceTripId && a.sjyid === b.sjyid && a.operatingDate === b.operatingDate && a.tripStartOffsetSeconds === b.tripStartOffsetSeconds && a.timezone === b.timezone && JSON.stringify(a.frequencyWindow) === JSON.stringify(b.frequencyWindow);
  }
  var leg = refine(discriminated("kind", {
    walk: object({ ...baseLeg, kind: one("walk"), distanceMeters: nullable(nonnegative) }),
    transfer: object({ ...baseLeg, kind: one("transfer"), distanceMeters: nullable(nonnegative) }),
    ride: object({ ...baseLeg, kind: one("ride"), mode: one("bus", "tram", "train", "boat", "cableway", "unknown"), line: nullable(str), headsign: nullable(str), trip, calls: array(call, 2), boardingCallId: str, alightingCallId: str, boardingTarget: target })
  }), (v, p, i) => {
    orderedTimes(v.plannedStart, v.plannedEnd, p, i);
    orderedTimes(v.expectedStart, v.expectedEnd, p, i);
    unique(v.instructions.map((x) => x.id), `${p}.instructions`, i);
    if (v.kind !== "ride") return;
    unique(v.calls.map((x) => x.id), `${p}.calls`, i);
    const board = v.calls.findIndex((x) => x.id === v.boardingCallId), alight = v.calls.findIndex((x) => x.id === v.alightingCallId);
    if (board < 0 || alight <= board) fail(i, p, "Boarding and later alighting calls must exist in order");
    else {
      if (v.calls[board].place.id !== v.from.id || v.calls[alight].place.id !== v.to.id) fail(i, p, "Leg endpoints must match selected calls");
      if (v.calls[board].pickup === "forbidden" || v.calls[alight].dropoff === "forbidden") fail(i, p, "Selected call forbids boarding or alighting");
    }
    if (v.boardingTarget.callId !== v.boardingCallId) fail(i, p, "Boarding target references another call");
    let lastSequence = -1;
    v.calls.forEach((c, index) => {
      if (!sameTripOccurrence(v.trip, c.trip)) fail(i, `${p}.calls[${index}]`, "Call belongs to another trip occurrence");
      if (c.stopSequence !== null) {
        if (c.stopSequence <= lastSequence) fail(i, p, "Source sequences must increase");
        lastSequence = c.stopSequence;
      }
      if (index > 0) orderedTimes(v.calls[index - 1].plannedDeparture ?? v.calls[index - 1].plannedArrival, c.plannedArrival ?? c.plannedDeparture, p, i);
    });
  });
  var journey = refine(object({ schemaVersion: one(1), id: str, revision: integer, origin: place, destination: place, preferences, legs: array(leg, 1), durationSeconds: nonnegative, warnings: array(str), evidence: evidenceList }), (v, p, i) => {
    unique(v.legs.map((x) => x.id), `${p}.legs`, i);
    if (v.legs[0].from.id !== v.origin.id || v.legs.at(-1).to.id !== v.destination.id) fail(i, p, "Journey endpoints do not match legs");
    v.legs.forEach((l, index) => {
      if (!index) return;
      const previous = v.legs[index - 1];
      if (previous.to.id !== l.from.id) fail(i, `${p}.legs[${index}]`, "Disconnected leg");
      orderedTimes(previous.plannedEnd, l.plannedStart, p, i);
    });
    const seconds = (Date.parse(v.legs.at(-1).plannedEnd) - Date.parse(v.legs[0].plannedStart)) / 1e3;
    if (seconds !== v.durationSeconds) fail(i, `${p}.durationSeconds`, "Duration must span first start to final end including waits");
  });
  var position = refine(object({ capturedAt: instant, rawCoordinate: nullable(coordinate), filteredCoordinate: nullable(coordinate), horizontalAccuracyMeters: nullable(nonnegative), accuracyBasis: one("sensor_reported", "measured", "unknown"), mapMatchedCoordinate: nullable(coordinate), floorCandidates: array(str), mode: one("gnss", "visual", "fused", "manual", "replay", "unknown"), confidence: one("reliable", "uncertain", "unavailable"), evidence: evidenceList }), (v, p, i) => {
    if (v.confidence === "reliable" && v.rawCoordinate === null && v.filteredCoordinate === null) fail(i, p, "Reliable position requires a coordinate");
  });
  var candidate = object({ departureCallId: str, line: nullable(str), headsign: nullable(str), downstreamStopIds: array(str), stopListComplete: bool, servesRequestedAlighting: one("yes", "no", "unknown"), evidence: evidenceList });
  var vision = refine(object({ id: str, capturedAt: instant, expiresAt: instant, frameId: str, trackId: nullable(str), imageWidth: number(1, Number.MAX_SAFE_INTEGER, true), imageHeight: number(1, Number.MAX_SAFE_INTEGER, true), box: nullable(object({ x: nonnegative, y: nonnegative, width: number(Number.MIN_VALUE), height: number(Number.MIN_VALUE) })), rawText: array(str), lineCandidates: array(str), destinationCandidates: array(str), candidates: array(candidate), association: one("matched", "conflicting", "ambiguous", "unknown"), evidence: evidenceList }), (v, p, i) => {
    orderedTimes(v.capturedAt, v.expiresAt, p, i);
    if (v.box && (v.box.x + v.box.width > v.imageWidth || v.box.y + v.box.height > v.imageHeight)) fail(i, p, "Box exceeds image bounds");
    if (v.association === "matched" && !v.trackId) fail(i, p, "Matched observation needs a track");
  });
  var serviceMatch = refine(object({ legId: str, trackId: nullable(str), status: one("matching", "conflicting", "unknown"), reasonCodes: array(str, 1), observationIds: array(str), expiresAt: instant, evidence: evidenceList }), (v, p, i) => {
    if (v.status === "matching" && (!v.trackId || !v.observationIds.length)) fail(i, p, "Matching service needs a track and supporting observation");
  });
  var visualPose = refine(object({ siteId: str, mapVersion: str, sessionId: str, frameId: str, capturedAt: instant, transform: nullable(object({ convention: one("T_site_camera"), storage: one("column_major"), units: one("meters"), siteAxes: one("ENU"), cameraAxes: one("x_right_y_up_z_back"), matrix: array(number(), 16) })), method: one("measured_landmark", "geometric_map", "provider", "unknown"), uncertaintyMeters: nullable(nonnegative), uncertaintyBasis: one("independent_checkpoints", "model_estimate", "unknown"), candidatePlaceIds: array(str), status: one("accepted", "ambiguous", "rejected"), reason: str, evidence: evidenceList }), (v, p, i) => {
    if (v.transform && v.transform.matrix.length !== 16) fail(i, p, "Transform needs exactly 16 values");
    if (v.status === "accepted" && (!v.transform || v.method === "unknown" || v.uncertaintyMeters === null || v.uncertaintyBasis === "unknown")) fail(i, p, "Accepted pose needs transform, method and uncertainty basis");
  });
  var itinerary = object({ schemaVersion: one(1), journeyId: str, revision: integer, legDigest: str, trips: array(trip), selectedCalls: array(object({ legId: str, boardingCallId: str, alightingCallId: str })) });
  var eventBase = { schemaVersion: one(1), id: str, sequence: integer, at: instant, journeyId: str, legId: nullable(str), evidence: evidenceList };
  var eventBranch = (type, data) => object({ ...eventBase, type: one(type), data });
  var event = discriminated("type", {
    location_observed: eventBranch("location_observed", position),
    connectivity_changed: eventBranch("connectivity_changed", object({ online: bool, reason: str })),
    target_changed: eventBranch("target_changed", object({ target, revision: integer, reason: str })),
    vision_observed: eventBranch("vision_observed", object({ observation: vision, match: serviceMatch })),
    vehicle_lost: eventBranch("vehicle_lost", object({ trackId: str, reason: str })),
    user_confirmed: eventBranch("user_confirmed", object({ action: one("boarded", "alighted", "arrived", "at_waiting_area"), reason: str })),
    departure_updated: eventBranch("departure_updated", object({ callId: str, expectedDeparture: nullable(instant), cancelled: bool })),
    connection_missed: eventBranch("connection_missed", object({ reason: str }))
  });
  var replay = refine(object({ schemaVersion: one(1), id: str, label: str, synthetic: one(true), clockStart: instant, journey, returnJourney: journey, events: array(event), expectedOutcomes: array(object({ eventId: str, expectation: str })) }), (v, p, i) => {
    unique(v.events.map((e) => e.id), `${p}.events`, i);
    v.events.forEach((e, index) => {
      const j = [v.journey, v.returnJourney].find((j2) => j2.id === e.journeyId);
      if (!j || e.legId !== null && !j.legs.some((l) => l.id === e.legId)) fail(i, `${p}.events[${index}]`, "Unknown journey or leg");
      orderedTimes(index ? v.events[index - 1].at : v.clockStart, e.at, p, i);
      if (index && e.sequence <= v.events[index - 1].sequence) fail(i, p, "Event sequences must strictly increase");
      if (e.evidence.some((item) => item.kind !== "simulated")) fail(i, p, "Synthetic replay events must be labelled simulated");
    });
    v.expectedOutcomes.forEach((o) => {
      if (!v.events.some((e) => e.id === o.eventId)) fail(i, p, "Expectation references an unknown event");
    });
  });
  var coordinateSchema = schema(coordinate);
  var evidenceSchema = schema(evidence);
  var placeSchema = schema(place);
  var frequencyWindowSchema = schema(frequencyWindow);
  var tripOccurrenceSchema = schema(trip);
  var boardingAssignmentSchema = schema(assignment);
  var boardingTargetSchema = schema(target);
  var stopCallSchema = schema(call);
  var legSchema = schema(leg);
  var journeySchema = schema(journey);
  var positionEstimateSchema = schema(position);
  var candidateServiceSchema = schema(candidate);
  var visionObservationSchema = schema(vision);
  var serviceMatchSchema = schema(serviceMatch);
  var visualPoseObservationSchema = schema(visualPose);
  var itineraryRefSchema = schema(itinerary);
  var navigationEventSchema = schema(event);
  var replayFixtureSchema = schema(replay);
  var journeySearchRequestSchema = schema(object({ schemaVersion: one(1), origin: place, destination: place, time: instant, timeMode: one("depart_at", "arrive_by"), preferences }));
  var journeySearchResponseSchema = schema(refine(object({ schemaVersion: one(1), journeys: array(journey), itineraryRefs: array(itinerary), generatedAt: instant, warnings: array(str) }), (v, p, i) => {
    unique(v.journeys.map((j) => j.id), p, i);
    if (v.journeys.length !== v.itineraryRefs.length || v.journeys.some((j, index) => j.id !== v.itineraryRefs[index]?.journeyId || j.revision !== v.itineraryRefs[index]?.revision)) fail(i, p, "Itinerary refs must correspond to journeys in order");
  }));
  var journeyRefreshRequestSchema = schema(object({ schemaVersion: one(1), itinerary }));
  var journeyReplanRequestSchema = schema(object({ schemaVersion: one(1), itinerary, currentPlace: place, destination: optional(place), preferences, time: instant }));
  var journeyRefreshResponseSchema = schema(object({ schemaVersion: one(1), journey: nullable(journey), events: array(event), status: one("unchanged", "updated", "snapshot_unavailable", "replan_required"), generatedAt: instant }));
  var placeSearchResponseSchema = schema(object({ schemaVersion: one(1), places: array(place), generatedAt: instant }));
  var departureBoardResponseSchema = schema(object({ schemaVersion: one(1), stop: place, calls: array(call), generatedAt: instant }));
  var boardingTargetResponseSchema = schema(object({ schemaVersion: one(1), target, generatedAt: instant }));
  var capabilityChecks = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, one("supported", "partial", "unsupported")]));
  var capabilitiesResponseSchema = schema(object({ schemaVersion: one(1), providers: array(object({ provider: str, capabilities: object(capabilityChecks), evidence: evidenceList })), generatedAt: instant }));
  var apiErrorResponseSchema = schema(object({ schemaVersion: one(1), error: object({ code: one("invalid_request", "not_found", "unavailable", "rate_limited", "snapshot_unavailable"), message: str, retryAfterSeconds: nullable(nonnegative) }) }));

  // packages/domain-ts/src/time.ts
  function instant2(value) {
    const n = Date.parse(value);
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(n)) throw new Error(`Invalid instant: ${value}`);
    return n;
  }
  function isFresh(at, now, ttlMs) {
    if (!at) return false;
    try {
      const age = instant2(now) - instant2(at);
      return age >= 0 && age <= ttlMs;
    } catch {
      return false;
    }
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // packages/domain-ts/src/geometry.ts
  function validCoordinate(c) {
    return c.length === 2 && c.every(Number.isFinite) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
  }
  function project(p, origin) {
    return [(p[0] - origin[0]) * Math.PI / 180 * 63710088e-1 * Math.cos(origin[1] * Math.PI / 180), (p[1] - origin[1]) * Math.PI / 180 * 63710088e-1];
  }
  function polygonDistance(point, polygon) {
    if (polygon.length < 3 || !polygon.every(validCoordinate)) return Infinity;
    const vertices = polygon.map((p) => project(p, point));
    let inside2 = false, minimum = Infinity;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const [x, y] = vertices[i], [u, v] = vertices[j];
      if (y > 0 !== v > 0 && 0 < x + (u - x) * -y / (v - y)) inside2 = !inside2;
      const length2 = (u - x) ** 2 + (v - y) ** 2;
      const t = length2 ? Math.max(0, Math.min(1, -(x * (u - x) + y * (v - y)) / length2)) : 0;
      minimum = Math.min(minimum, Math.hypot(x + t * (u - x), y + t * (v - y)));
    }
    return inside2 ? 0 : minimum;
  }

  // packages/domain-ts/src/positioning.ts
  function assessPositionEstimate(position2, now, options = {}) {
    if (!position2.rawCoordinate) return null;
    const assessment = assessPosition({
      coordinate: position2.rawCoordinate,
      observedAt: position2.capturedAt,
      horizontalAccuracyMeters: position2.accuracyBasis === "unknown" ? null : position2.horizontalAccuracyMeters,
      floorCandidates: position2.floorCandidates,
      source: position2.mode
    }, now, options);
    if (position2.confidence !== "reliable" && assessment.quality === "usable") {
      assessment.quality = "uncertain";
      assessment.reasons.push("sensor_confidence_unconfirmed");
    }
    return assessment;
  }
  function assessPosition(raw, now, options = {}) {
    const result = { raw: clone(raw), coordinate: [...raw.coordinate], uncertaintyMeters: raw.horizontalAccuracyMeters, quality: "uncertain", candidateAreaIds: [], floorCandidates: [...raw.floorCandidates], reasons: [], pedestrianAreaConfirmed: false };
    if (!validCoordinate(raw.coordinate) || raw.horizontalAccuracyMeters !== null && (!Number.isFinite(raw.horizontalAccuracyMeters) || raw.horizontalAccuracyMeters < 0)) {
      result.quality = "invalid";
      result.reasons.push("invalid_sensor_measurement");
      return result;
    }
    if (!isFresh(raw.observedAt, now, options.maxAgeMs ?? 1e4)) {
      result.quality = "stale";
      result.reasons.push("stale_or_future_location");
      return result;
    }
    if (raw.horizontalAccuracyMeters === null) {
      result.reasons.push("unknown_sensor_uncertainty");
      return result;
    }
    const candidates = (options.areas ?? []).filter((area) => {
      if (area.validUntil && (!Number.isFinite(Date.parse(area.validUntil)) || Date.parse(area.validUntil) < Date.parse(now))) return false;
      if (area.level !== null && raw.floorCandidates.length && !raw.floorCandidates.includes(area.level)) return false;
      return polygonDistance(raw.coordinate, area.polygon) <= raw.horizontalAccuracyMeters;
    });
    result.candidateAreaIds = candidates.map((area) => area.id);
    if (!result.floorCandidates.length) result.floorCandidates = [...new Set(candidates.flatMap((area) => area.level === null ? [] : [area.level]))];
    if (raw.horizontalAccuracyMeters > (options.usableAccuracyMeters ?? 15)) result.reasons.push("wide_sensor_uncertainty");
    if (candidates.length > 1) result.reasons.push("multiple_pedestrian_areas");
    if (result.floorCandidates.length > 1) result.reasons.push("ambiguous_floor");
    if (candidates.length === 1 && candidates[0].status !== "verified_area") result.reasons.push("unverified_pedestrian_area");
    result.quality = result.reasons.length ? "uncertain" : "usable";
    return result;
  }

  // packages/domain-ts/src/vision.ts
  var normalize = (s) => s.normalize("NFKC").trim().toLocaleLowerCase("de-CH").replace(/\s+/g, " ");
  function matchVehicleService(observations, context, now) {
    const result = { state: "unknown", legId: context.legId, trackId: context.activeTrackId, candidateId: null, reasons: [], observationIds: [], expiresAt: null };
    const abstain = (reason, conflicting = false) => ({ ...result, state: conflicting ? "conflicting" : "unknown", reasons: [reason] });
    let clock;
    try {
      clock = instant2(now);
    } catch {
      return abstain("invalid_clock");
    }
    if (context.selectedRevision !== context.journeyRevision || !isFresh(context.updatedAt, now, 9e4) || !isFresh(now, context.expiresAt, 9e4)) return abstain("stale_route_context");
    if (!context.activeTrackId || context.lostTrackIds?.includes(context.activeTrackId)) return abstain("track_lost");
    if (!context.destination?.trim()) return abstain("missing_route_destination");
    const recent = observations.filter((o) => isFresh(o.at, now, 2e3));
    if (recent.some((o) => o.trackId !== context.activeTrackId)) return abstain("track_swap_or_multiple_tracks");
    const readings = recent.filter((o) => o.trackId === context.activeTrackId);
    if (!readings.length) return abstain("stale_visual_evidence");
    if (readings.some((o) => o.association !== "supported" || o.lines.length !== 1 || o.destinations.length > 1)) return abstain("ambiguous_visual_evidence");
    if (readings.some((o) => !o.destinations[0]?.trim())) return abstain("missing_destination");
    if (readings.some((o) => normalize(o.lines[0]) !== normalize(context.line) || normalize(o.destinations[0]) !== normalize(context.destination))) return abstain("conflicting_line_or_direction", true);
    const distinct = [...new Map(readings.map((o) => [o.id, o])).values()];
    const times = distinct.map((o) => instant2(o.at));
    if (distinct.length < 2 || Math.max(...times) - Math.min(...times) < 400) return abstain("unstable_readings");
    const candidates = context.candidates.filter((c) => c.departureCallId === context.boardingCallId && normalize(c.line) === normalize(context.line) && c.destination !== null && normalize(c.destination) === normalize(context.destination));
    if (candidates.length !== 1) return abstain(candidates.length ? "ambiguous_service_candidates" : "no_compatible_service");
    const candidate2 = candidates[0];
    if (!Number.isFinite(Date.parse(candidate2.expiresAt)) || Date.parse(candidate2.expiresAt) < clock) return abstain("stale_service_candidate");
    if (candidate2.servesRequestedAlighting === "no" || candidate2.stopListComplete && !candidate2.downstreamCallIds.includes(context.alightingCallId)) return abstain("short_turn_or_wrong_downstream", true);
    if (candidate2.servesRequestedAlighting !== "yes" || !candidate2.downstreamCallIds.includes(context.alightingCallId)) return abstain("unknown_downstream_compatibility");
    return { ...result, state: "matching", candidateId: candidate2.id, observationIds: distinct.map((o) => o.id), reasons: ["stable_line_destination_and_downstream"], expiresAt: new Date(Math.min(Math.max(...times) + 2e3, instant2(context.expiresAt), instant2(candidate2.expiresAt))).toISOString() };
  }

  // packages/domain-ts/src/contract-vision.ts
  function matchJourneyVehicle(observations, journey2, legId, contextAt, now, activeTrackId, lostTrackIds = []) {
    const leg2 = journey2.legs.find((l) => l.id === legId && l.kind === "ride");
    const unknown = (reason) => ({ legId, trackId: activeTrackId, status: "unknown", reasonCodes: [reason], observationIds: [], expiresAt: now, evidence: observations.at(-1)?.evidence ?? journey2.evidence });
    if (!leg2 || !leg2.line) return unknown("missing_route_context");
    const alight = leg2.calls.find((c) => c.id === leg2.alightingCallId);
    const alightIds = /* @__PURE__ */ new Set([alight.place.id, ...alight.place.sourceRefs.map((r) => r.id)]);
    const boardIndex = leg2.calls.findIndex((c) => c.id === leg2.boardingCallId);
    const afterBoard = leg2.calls.slice(boardIndex + 1);
    if (afterBoard.filter((c) => c.place.id === alight.place.id).length > 1) return unknown("ambiguous_repeated_stop");
    const latest = observations.at(-1);
    if (!latest || latest.trackId !== activeTrackId || !isFresh(latest.capturedAt, now, 2e3) || instant2(latest.expiresAt) < instant2(now)) return unknown("stale_visual_evidence");
    if (latest.association === "conflicting") return { ...unknown("conflicting_visual_association"), status: "conflicting" };
    const candidates = latest.candidates.map((candidate2, index) => {
      const fresh = candidate2.evidence.length > 0 && candidate2.evidence.every((e) => isFresh(e.observedAt, now, 9e4) && (!e.validUntil || instant2(e.validUntil) >= instant2(now)) && (!e.validFrom || instant2(e.validFrom) <= instant2(now)));
      const expectedCalls = afterBoard.slice(0, afterBoard.findIndex((c) => c.id === leg2.alightingCallId) + 1);
      let previous = -1, compatible = true;
      for (const call3 of expectedCalls) {
        const refs = /* @__PURE__ */ new Set([call3.place.id, ...call3.place.sourceRefs.map((r) => r.id)]);
        const next = candidate2.downstreamStopIds.findIndex((id, index2) => index2 > previous && refs.has(id));
        if (next < 0) {
          compatible = false;
          break;
        }
        previous = next;
      }
      return {
        id: `${candidate2.departureCallId}:${index}`,
        departureCallId: candidate2.departureCallId,
        line: candidate2.line ?? "",
        destination: candidate2.headsign,
        downstreamCallIds: candidate2.downstreamStopIds.some((id) => alightIds.has(id)) ? [leg2.alightingCallId] : [],
        stopListComplete: candidate2.stopListComplete,
        servesRequestedAlighting: compatible ? candidate2.servesRequestedAlighting : candidate2.stopListComplete ? "no" : "unknown",
        expiresAt: fresh ? new Date(Math.min(...candidate2.evidence.map((e) => Math.min(instant2(e.observedAt) + 9e4, e.validUntil ? instant2(e.validUntil) : Infinity)))).toISOString() : new Date(instant2(now) - 1).toISOString()
      };
    });
    const validObservations = observations.filter((o) => instant2(o.expiresAt) >= instant2(now));
    const match = matchVehicleService(validObservations.map((o) => ({ id: o.frameId, trackId: o.trackId ?? "", at: o.capturedAt, lines: o.lineCandidates, destinations: o.destinationCandidates, association: o.association === "matched" ? "supported" : o.association === "unknown" ? "unknown" : "ambiguous" })), {
      legId,
      journeyRevision: journey2.revision,
      selectedRevision: journey2.revision,
      boardingCallId: leg2.boardingCallId,
      alightingCallId: leg2.alightingCallId,
      line: leg2.line,
      destination: leg2.headsign,
      updatedAt: contextAt,
      expiresAt: new Date(instant2(contextAt) + 9e4).toISOString(),
      candidates,
      activeTrackId,
      lostTrackIds
    }, now);
    return { legId, trackId: match.trackId, status: match.state, reasonCodes: match.reasons, observationIds: match.observationIds.map((id) => observations.find((o) => o.frameId === id).id), expiresAt: match.expiresAt ?? now, evidence: latest.evidence };
  }

  // packages/domain-ts/src/navigation.ts
  var PHASES = ["walking", "approaching", "waiting", "riding", "alighting", "transfer", "final_walk", "arrived"];
  function currentLeg(state2) {
    return state2.journey.legs[state2.legIndex];
  }
  function initialPhase(journey2, index) {
    const leg2 = journey2.legs[index];
    return leg2.kind === "ride" ? "approaching" : leg2.kind === "transfer" ? "transfer" : index === journey2.legs.length - 1 ? "final_walk" : "walking";
  }
  function record(state2, reason, eventId = null) {
    state2.history.push({ at: state2.now, reason, phase: state2.phase, legId: currentLeg(state2).id, eventId });
  }
  function clearVisual(state2) {
    state2.observations = [];
    state2.serviceMatch = null;
    state2.lostTrackIds = [];
  }
  function clearConfirmations(state2) {
    state2.confirmations = { waitingTargetId: null, boardedLegId: null };
    clearVisual(state2);
  }
  function nextLeg(state2) {
    clearConfirmations(state2);
    state2.predictionFresh = false;
    state2.predictionObservedAt = null;
    if (state2.legIndex + 1 === state2.journey.legs.length) {
      state2.phase = "arrived";
      return;
    }
    state2.legIndex++;
    state2.phase = initialPhase(state2.journey, state2.legIndex);
  }
  function recomputeUncertainty(state2) {
    const leg2 = currentLeg(state2);
    const targetUncertain = leg2.kind === "ride" && ["approaching", "waiting"].includes(state2.phase) && (leg2.boardingTarget.pedestrianTargetStatus !== "verified_area" || ["conflicting", "candidates_only", "stop_only", "unavailable"].includes(leg2.boardingTarget.assignment.status));
    state2.overlays.uncertain = state2.phase !== "arrived" && (state2.positionAssessment?.quality !== "usable" || targetUncertain);
  }
  function createNavigationState(journey2, now) {
    journeySchema.parse(journey2);
    instant2(now);
    const state2 = {
      schemaVersion: 1,
      journey: clone(journey2),
      legIndex: 0,
      phase: initialPhase(journey2, 0),
      now,
      contextAt: now,
      lastSequence: -1,
      lastEventAt: null,
      processedEventIds: [],
      overlays: { offline: false, disrupted: false, replanning: false, uncertain: true },
      position: null,
      positionAssessment: null,
      predictionFresh: false,
      predictionObservedAt: null,
      observations: [],
      serviceMatch: null,
      lostTrackIds: [],
      confirmations: { waitingTargetId: null, boardedLegId: null },
      history: []
    };
    record(state2, "journey_started");
    return state2;
  }
  function advanceNavigationClock(input, now) {
    if (instant2(now) < instant2(input.now)) throw new Error("Navigation clock cannot move backwards");
    const state2 = clone(input);
    state2.now = now;
    state2.positionAssessment = state2.position ? assessPositionEstimate(state2.position, now) : null;
    state2.predictionFresh = !state2.overlays.offline && isFresh(state2.predictionObservedAt, now, 9e4);
    state2.observations = state2.observations.filter((o) => isFresh(o.capturedAt, now, 2e3) && instant2(o.expiresAt) >= instant2(now));
    if (state2.serviceMatch && (instant2(state2.serviceMatch.expiresAt) < instant2(now) || !isFresh(state2.contextAt, now, 9e4))) state2.serviceMatch = null;
    recomputeUncertainty(state2);
    return state2;
  }
  function reduceNavigation(input, event3) {
    if (!navigationEventSchema.safeParse(event3).success || event3.journeyId !== input.journey.id || event3.sequence <= input.lastSequence || input.processedEventIds.includes(event3.id) || instant2(event3.at) < instant2(input.now) || input.lastEventAt && instant2(event3.at) < instant2(input.lastEventAt)) return input;
    const eventLegIndex = input.journey.legs.findIndex((l) => l.id === event3.legId);
    if (event3.legId !== null && eventLegIndex < 0) return input;
    if (["user_confirmed", "vision_observed", "connection_missed", "vehicle_lost"].includes(event3.type) && event3.legId !== currentLeg(input).id) return input;
    if (event3.type === "target_changed" && (event3.data.revision <= input.journey.revision || eventLegIndex < 0 || input.journey.legs[eventLegIndex].kind !== "ride")) return input;
    let state2 = advanceNavigationClock(input, event3.at);
    state2.lastSequence = event3.sequence;
    state2.lastEventAt = event3.at;
    state2.processedEventIds.push(event3.id);
    const leg2 = currentLeg(state2);
    switch (event3.type) {
      case "location_observed":
        if (instant2(event3.data.capturedAt) <= instant2(event3.at) && (!state2.position || instant2(event3.data.capturedAt) >= instant2(state2.position.capturedAt))) state2.position = clone(event3.data);
        record(state2, "location_observed_without_progress_inference", event3.id);
        break;
      case "connectivity_changed":
        state2.overlays.offline = !event3.data.online;
        record(state2, event3.data.reason, event3.id);
        break;
      case "target_changed": {
        const changed = state2.journey.legs[eventLegIndex];
        if (changed.kind !== "ride" || changed.boardingCallId !== event3.data.target.callId) return input;
        changed.boardingTarget = clone(event3.data.target);
        state2.journey.revision = event3.data.revision;
        state2.contextAt = event3.at;
        if (eventLegIndex === state2.legIndex) {
          clearConfirmations(state2);
          if (state2.phase === "waiting") state2.phase = "approaching";
        }
        record(state2, event3.data.reason, event3.id);
        break;
      }
      case "vision_observed": {
        if (leg2.kind !== "ride" || !["approaching", "waiting"].includes(state2.phase)) break;
        const observation = event3.data.observation;
        if (state2.observations.some((o) => o.id === observation.id || o.frameId === observation.frameId)) break;
        state2.observations.push(clone(observation));
        state2.serviceMatch = matchJourneyVehicle(state2.observations, state2.journey, leg2.id, state2.contextAt, state2.now, observation.trackId, state2.lostTrackIds);
        record(state2, state2.serviceMatch.reasonCodes.join(", "), event3.id);
        break;
      }
      case "vehicle_lost":
        state2.lostTrackIds.push(event3.data.trackId);
        state2.observations = state2.observations.filter((o) => o.trackId !== event3.data.trackId);
        if (state2.serviceMatch?.trackId === event3.data.trackId) state2.serviceMatch = null;
        record(state2, event3.data.reason, event3.id);
        break;
      case "user_confirmed": {
        const action = event3.data.action;
        if (action === "arrived" && leg2.kind !== "ride" && state2.phase !== "arrived") nextLeg(state2);
        else if (action === "at_waiting_area") {
          if (leg2.kind !== "ride") {
            const next = state2.journey.legs[state2.legIndex + 1];
            if (!next || next.kind !== "ride" || leg2.to.id !== next.from.id) break;
            nextLeg(state2);
          }
          const ride = currentLeg(state2);
          if (ride.kind !== "ride" || !["approaching", "waiting"].includes(state2.phase)) break;
          state2.phase = "waiting";
          state2.confirmations.waitingTargetId = ride.boardingTarget.id;
        } else if (action === "boarded" && leg2.kind === "ride" && ["waiting", "approaching"].includes(state2.phase)) {
          const call3 = leg2.calls.find((c) => c.id === leg2.boardingCallId);
          if (state2.overlays.disrupted || state2.overlays.replanning || ["cancelled", "skipped"].includes(call3.status) || call3.pickup === "forbidden") break;
          state2.phase = "riding";
          state2.confirmations.boardedLegId = leg2.id;
          clearVisual(state2);
        } else if (action === "alighted" && leg2.kind === "ride" && ["riding", "alighting"].includes(state2.phase)) nextLeg(state2);
        else break;
        record(state2, `user_${action}: ${event3.data.reason}`, event3.id);
        break;
      }
      case "departure_updated": {
        const updatedLeg = eventLegIndex < 0 ? leg2 : state2.journey.legs[eventLegIndex];
        if (updatedLeg.kind !== "ride") break;
        const call3 = updatedLeg.calls.find((c) => c.id === event3.data.callId);
        if (!call3) break;
        call3.expectedDeparture = event3.data.expectedDeparture;
        if (event3.data.cancelled) call3.status = "cancelled";
        call3.evidence = clone(event3.evidence);
        if (eventLegIndex === state2.legIndex || updatedLeg.id === leg2.id) {
          state2.predictionObservedAt = event3.evidence.find((e) => e.kind === "predicted" || e.kind === "simulated" || e.kind === "replay")?.observedAt ?? null;
          if (event3.data.cancelled) {
            state2.overlays.disrupted = true;
            state2.overlays.replanning = true;
            clearVisual(state2);
          }
        }
        record(state2, event3.data.cancelled ? "departure_cancelled" : "departure_updated", event3.id);
        break;
      }
      case "connection_missed":
        state2.overlays.disrupted = true;
        state2.overlays.replanning = true;
        clearConfirmations(state2);
        record(state2, event3.data.reason, event3.id);
        break;
    }
    state2 = advanceNavigationClock(state2, event3.at);
    return state2;
  }
  function refreshJourney(input, journey2, now) {
    journeySchema.parse(journey2);
    if (journey2.id !== input.journey.id || journey2.revision <= input.journey.revision) return input;
    const state2 = advanceNavigationClock(input, now), old = currentLeg(state2), index = journey2.legs.findIndex((l) => l.id === old.id);
    const replacement = journey2.legs[index];
    if (!replacement || replacement.kind !== old.kind || replacement.from.id !== old.from.id || replacement.to.id !== old.to.id || old.kind === "ride" && replacement.kind === "ride" && (!old.trip.sourceTripId || !replacement.trip.sourceTripId || !sameTripOccurrence(old.trip, replacement.trip) || old.boardingCallId !== replacement.boardingCallId || old.alightingCallId !== replacement.alightingCallId)) {
      state2.overlays.replanning = true;
      clearConfirmations(state2);
      record(state2, "refresh_requires_explicit_replan");
      return state2;
    }
    const targetChanged = old.kind === "ride" && replacement.kind === "ride" && JSON.stringify(old.boardingTarget) !== JSON.stringify(replacement.boardingTarget);
    state2.journey = clone(journey2);
    state2.legIndex = index;
    state2.contextAt = now;
    clearVisual(state2);
    if (targetChanged) {
      clearConfirmations(state2);
      if (state2.phase === "waiting") state2.phase = "approaching";
    }
    recomputeUncertainty(state2);
    record(state2, "journey_revision_refreshed");
    return state2;
  }
  function prepareAlighting(input, now) {
    if (input.phase !== "riding") return input;
    const state2 = advanceNavigationClock(input, now);
    state2.phase = "alighting";
    record(state2, "user_preparing_to_alight");
    return state2;
  }
  function correctProgress(input, correction, now) {
    if (correction.revision !== input.journey.revision || !correction.reason.trim()) throw new Error("Correction requires current revision and reason");
    const index = input.journey.legs.findIndex((l) => l.id === correction.legId), leg2 = input.journey.legs[index];
    if (!leg2 || !phaseCompatible(input.journey, index, correction.phase)) throw new Error("Correction phase incompatible with leg");
    const state2 = advanceNavigationClock(input, now);
    state2.legIndex = index;
    state2.phase = correction.phase;
    clearConfirmations(state2);
    if (index !== input.legIndex) {
      state2.predictionFresh = false;
      state2.predictionObservedAt = null;
    }
    if (["riding", "alighting"].includes(state2.phase)) state2.confirmations.boardedLegId = leg2.id;
    if (state2.phase === "waiting" && leg2.kind === "ride") state2.confirmations.waitingTargetId = leg2.boardingTarget.id;
    recomputeUncertainty(state2);
    record(state2, `manual_correction: ${correction.reason}`);
    return state2;
  }
  function phaseCompatible(journey2, index, phase) {
    const leg2 = journey2.legs[index];
    if (!leg2) return false;
    if (phase === "arrived") return index === journey2.legs.length - 1;
    if (leg2.kind === "ride") return ["approaching", "waiting", "riding", "alighting"].includes(phase);
    return phase === initialPhase(journey2, index);
  }
  function acceptReplan(input, journey2, now) {
    const state2 = createNavigationState(journey2, now);
    if (instant2(now) < instant2(input.now)) throw new Error("Navigation clock cannot move backwards");
    state2.overlays.offline = input.overlays.offline;
    state2.history = [...clone(input.history), ...state2.history];
    record(state2, "user_accepted_replan");
    return state2;
  }
  function startReturnJourney(input, journey2, now) {
    if (input.phase !== "arrived" || journey2.origin.id !== input.journey.destination.id || journey2.destination.id !== input.journey.origin.id) throw new Error("Return journey requires arrival and reversed endpoints");
    const state2 = acceptReplan(input, journey2, now);
    record(state2, "return_journey_started");
    return state2;
  }
  function serializeNavigation(state2) {
    return JSON.stringify(state2);
  }
  function restoreNavigation(json) {
    const v = JSON.parse(json);
    if (!v || v.schemaVersion !== 1) throw new Error("Unsupported navigation state");
    journeySchema.parse(v.journey);
    instant2(v.now);
    instant2(v.contextAt);
    if (!Number.isInteger(v.legIndex) || !PHASES.includes(v.phase) || !phaseCompatible(v.journey, v.legIndex, v.phase) || !Number.isInteger(v.lastSequence) || v.lastSequence < -1) throw new Error("Invalid persisted progress");
    if (!Array.isArray(v.processedEventIds) || v.processedEventIds.some((id) => typeof id !== "string") || new Set(v.processedEventIds).size !== v.processedEventIds.length || !Array.isArray(v.lostTrackIds) || v.lostTrackIds.some((id) => typeof id !== "string")) throw new Error("Invalid event cursor");
    if (!v.overlays || ["offline", "disrupted", "replanning", "uncertain"].some((k) => typeof v.overlays[k] !== "boolean")) throw new Error("Invalid overlays");
    if (!v.confirmations || [v.confirmations.waitingTargetId, v.confirmations.boardedLegId].some((x) => x !== null && typeof x !== "string")) throw new Error("Invalid confirmations");
    const leg2 = currentLeg(v);
    if (v.confirmations.waitingTargetId !== null && (leg2.kind !== "ride" || v.confirmations.waitingTargetId !== leg2.boardingTarget.id) || v.confirmations.boardedLegId !== null && (leg2.kind !== "ride" || v.confirmations.boardedLegId !== leg2.id)) throw new Error("Confirmation refers to another target or leg");
    if (v.position !== null) positionEstimateSchema.parse(v.position);
    if (!Array.isArray(v.observations)) throw new Error("Invalid observations");
    v.observations.forEach((o) => visionObservationSchema.parse(o));
    if (v.serviceMatch !== null) serviceMatchSchema.parse(v.serviceMatch);
    if (v.lastEventAt !== null && instant2(v.lastEventAt) > instant2(v.now)) throw new Error("Invalid persisted clock");
    if (v.predictionObservedAt !== null) instant2(v.predictionObservedAt);
    if (!Array.isArray(v.history) || v.history.some((h) => !h || typeof h.reason !== "string" || !PHASES.includes(h.phase) || typeof h.legId !== "string" || !Number.isFinite(Date.parse(h.at)))) throw new Error("Invalid history");
    v.serviceMatch = v.observations.length ? matchJourneyVehicle(v.observations, v.journey, currentLeg(v).id, v.contextAt, v.now, v.observations.at(-1).trackId, v.lostTrackIds) : null;
    return advanceNavigationClock(v, v.now);
  }

  // packages/domain-ts/src/replay.ts
  function createReplay(fixture, options = {}) {
    replayFixtureSchema.parse(fixture);
    const direction = options.direction ?? "outbound", journey2 = direction === "outbound" ? fixture.journey : fixture.returnJourney;
    const start = direction === "outbound" ? fixture.clockStart : journey2.legs[0].plannedStart;
    const replay3 = { fixture: clone(fixture), navigation: createNavigationState(journey2, start), cursor: 0, paused: options.paused ?? false, speed: options.speed ?? 1, direction };
    return setReplayPlayback(replay3, { speed: replay3.speed });
  }
  function setReplayPlayback(input, playback) {
    const state2 = clone(input);
    if (playback.speed !== void 0) {
      if (!Number.isFinite(playback.speed) || playback.speed <= 0 || playback.speed > 1e3) throw new Error("Replay speed must be in (0, 1000]");
      state2.speed = playback.speed;
    }
    if (playback.paused !== void 0) state2.paused = playback.paused;
    return state2;
  }
  function advanceReplay(input, elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Replay elapsed time must be nonnegative");
    if (input.paused) return input;
    const state2 = clone(input);
    const lastEventTime = Math.max(...state2.fixture.events.filter((e) => e.journeyId === state2.navigation.journey.id).map((e) => instant2(e.at)), instant2(state2.navigation.journey.legs.at(-1).plannedEnd));
    const end = Math.max(instant2(state2.navigation.now), Math.min(lastEventTime, instant2(state2.navigation.now) + elapsedMs * state2.speed));
    while (state2.cursor < state2.fixture.events.length) {
      const event3 = state2.fixture.events[state2.cursor];
      if (event3.journeyId !== state2.navigation.journey.id) {
        if (state2.direction === "outbound" && event3.journeyId === state2.fixture.returnJourney.id) break;
        state2.cursor++;
        continue;
      }
      if (instant2(event3.at) > end) break;
      state2.navigation = reduceNavigation(state2.navigation, event3);
      state2.cursor++;
    }
    state2.navigation = advanceNavigationClock(state2.navigation, new Date(end).toISOString());
    return state2;
  }
  function startReplayReturn(input) {
    const state2 = clone(input);
    const start = Math.max(instant2(state2.navigation.now), instant2(state2.fixture.returnJourney.legs[0].plannedStart));
    state2.navigation = startReturnJourney(state2.navigation, state2.fixture.returnJourney, new Date(start).toISOString());
    state2.direction = "return";
    return state2;
  }

  // packages/ios-bridge/src/transport.ts
  var digest = (value) => encodeURIComponent(JSON.stringify(value));
  var ProviderError = class extends Error {
    constructor(code, message, _status) {
      super(message);
      this.code = code;
    }
    code;
  };
  var PROVIDER = "transport.opendata.ch";
  var record2 = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var list = (value) => Array.isArray(value) ? value.map(record2) : [];
  var textValue = (value) => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  function instant3(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
    const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const timestamp = Date.parse(normalized);
    const day = normalized.slice(0, 10);
    if (!Number.isFinite(timestamp) || (/* @__PURE__ */ new Date(`${day}T12:00:00Z`)).toISOString().slice(0, 10) !== day) return null;
    return normalized;
  }
  function swissDateTime(value) {
    const date2 = new Date(value);
    if (!Number.isFinite(date2.getTime())) throw new ProviderError("invalid_request", "Invalid request time.", 400);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date2);
    const get = (name) => parts.find((p) => p.type === name).value;
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  }
  function transportCoordinate(value) {
    const raw = record2(value);
    if (raw.type !== "WGS84" || typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || Math.abs(raw.x) > 90 || Math.abs(raw.y) > 180) return null;
    return [raw.y, raw.x];
  }
  function sourceEvidence(at, predicted = false) {
    return [{ source: PROVIDER, fetchedAt: at, kind: predicted ? "predicted" : "scheduled", quality: "supported", ...predicted ? { validUntil: new Date(Date.parse(at) + 9e4).toISOString() } : {} }];
  }
  function normalizePlace(value, at) {
    const raw = record2(value), id = textValue(raw.id), name = textValue(raw.name), coordinate2 = transportCoordinate(raw.coordinate ?? raw.coordinates);
    if (!name) throw new ProviderError("provider_invalid", "Transit source returned a place without a name.");
    return placeSchema.parse({ id: id ? `${PROVIDER}:${id}` : `ios-local:place:${digest([name, coordinate2])}`, name, kind: raw.type === "address" ? "address" : raw.type === "poi" ? "poi" : id ? "stop" : "unknown", coordinate: coordinate2, parentId: null, sourceRefs: id ? [{ provider: PROVIDER, id, feedVersion: null }] : [], evidence: sourceEvidence(at) });
  }
  function resolveAssignment(input, at) {
    const label = textValue(input.label), mapped = textValue(input.mappedLabel), sourceRef2 = input.sourceRef ?? null;
    const conflict = !!(sourceRef2 && label && mapped && label !== mapped);
    return { status: conflict ? "conflicting" : label ? "candidates_only" : "stop_only", sourceRef: sourceRef2, originalLabel: label, label, candidates: [...new Set([label, mapped].filter((v) => !!v))], conflictReason: conflict ? `Source boarding ID maps to ${mapped}, but source display label is ${label}.` : null, evidence: sourceEvidence(at, input.predicted) };
  }
  function targetForCall(call3) {
    return { id: `ios-local:target:${digest(call3.id)}`, callId: call3.id, assignment: call3.currentAssignment, transitCoordinate: call3.place.coordinate, pedestrianArea: null, pedestrianTargetStatus: "unavailable", approachEntrance: null, level: null, precisionMeters: null, evidence: call3.currentAssignment.evidence };
  }
  var sourceStation = (stop) => record2(stop.station ?? stop.location);
  var stationKey = (stop) => {
    const station = sourceStation(stop), id = textValue(station.id);
    return id ? `id:${id}` : JSON.stringify([textValue(station.name), transportCoordinate(station.coordinate)]);
  };
  var stopKey = (stop) => JSON.stringify([stationKey(stop), instant3(stop.arrival), instant3(stop.departure)]);
  var endpointMatches = (candidate2, endpoint, role) => {
    if (stationKey(candidate2) !== stationKey(endpoint)) return false;
    const time = instant3(endpoint[role]);
    if (!time || instant3(candidate2[role]) !== time) return false;
    const other = role === "departure" ? "arrival" : "departure";
    return !instant3(endpoint[other]) || !instant3(candidate2[other]) || instant3(endpoint[other]) === instant3(candidate2[other]);
  };
  var descriptor = (journey2) => ({ name: textValue(journey2.name), number: textValue(journey2.number), category: textValue(journey2.category), operator: textValue(journey2.operator), to: textValue(journey2.to) });
  function makeItineraryRef(journey2) {
    const rides = journey2.legs.filter((leg2) => leg2.kind === "ride");
    return { schemaVersion: 1, journeyId: journey2.id, revision: journey2.revision, legDigest: digest(journey2.legs.map((l) => [l.id, l.kind, l.from.id, l.to.id, l.plannedStart, l.plannedEnd])), trips: rides.map((l) => l.trip), selectedCalls: rides.map((l) => ({ legId: l.id, boardingCallId: l.boardingCallId, alightingCallId: l.alightingCallId })) };
  }
  var LocalTransportNormalizer = class {
    trip(journey2, at) {
      return { provider: PROVIDER, feedVersion: null, sourceTripId: null, sjyid: null, operatingDate: swissDateTime(at).date, tripStartOffsetSeconds: null, timezone: "Europe/Zurich", frequencyWindow: null };
    }
    call(stop, journey2, trip2, at, index) {
      const place2 = normalizePlace(sourceStation(stop), at), prognosis = record2(stop.prognosis);
      const plannedArrival = instant3(stop.arrival), plannedDeparture = instant3(stop.departure);
      const expectedArrival = instant3(prognosis.arrival), expectedDeparture = instant3(prognosis.departure);
      const plannedAssignment = resolveAssignment({ label: textValue(stop.platform) }, at);
      const currentAssignment = textValue(prognosis.platform) ? resolveAssignment({ label: textValue(prognosis.platform), predicted: true }, at) : plannedAssignment;
      const context = { provider: PROVIDER, station: textValue(sourceStation(stop).id), plannedArrival, plannedDeparture, descriptor: descriptor(journey2), index };
      return stopCallSchema.parse({ id: `ios-local:call:${digest(context)}`, trip: trip2, stopSequence: null, place: place2, plannedArrival, plannedDeparture, expectedArrival, expectedDeparture, plannedAssignment, currentAssignment, pickup: "unknown", dropoff: "unknown", status: stop.cancelled === true ? "cancelled" : "scheduled", evidence: sourceEvidence(at, !!(expectedArrival || expectedDeparture)) });
    }
    connection(raw, request, at) {
      const legs = [], warnings = ["Transit geometry connects reported stops schematically; it is not a track or pedestrian route.", "Boarding labels are source candidates. Pedestrian waiting areas and accessibility are unverified.", "Source feed and trip-occurrence IDs are unavailable; live refresh may require a new search."];
      const id = `ios-local:journey:${digest([request.origin.id, request.destination.id, list(raw.sections).map((s) => [stopKey(record2(s.departure)), stopKey(record2(s.arrival)), descriptor(record2(s.journey))])])}`;
      if (request.preferences.stepFree) warnings.push("Step-free preference cannot be verified by this provider.");
      if (request.preferences.maxWalkMeters !== null) warnings.push("Maximum walking distance cannot be enforced where source walking distances are missing.");
      for (const [index, section] of list(raw.sections).entries()) {
        const departure = record2(section.departure), arrival = record2(section.arrival), service = record2(section.journey);
        const start = instant3(departure.departure) ?? instant3(departure.arrival), end = instant3(arrival.arrival) ?? instant3(arrival.departure);
        if (!start || !end) throw new ProviderError("provider_invalid", "A journey section has no valid times.");
        const from = normalizePlace(sourceStation(departure), at), to = normalizePlace(sourceStation(arrival), at);
        const legId = `${id}:leg:${index}`;
        const base = { id: legId, from, to, plannedStart: start, plannedEnd: end, expectedStart: instant3(record2(departure.prognosis).departure), expectedEnd: instant3(record2(arrival.prognosis).arrival), accessibility: "unknown", evidence: sourceEvidence(at), instructions: [] };
        if (section.journey) {
          let stops = list(service.passList);
          const starts = stops.flatMap((s, i) => endpointMatches(s, departure, "departure") ? [i] : []);
          const ends = stops.flatMap((s, i) => endpointMatches(s, arrival, "arrival") ? [i] : []);
          const first = starts[0], last2 = ends[0];
          stops = starts.length === 1 && ends.length === 1 && last2 > first ? stops.slice(first, last2 + 1) : [departure, arrival];
          stops[0] = { ...stops[0], ...departure };
          stops[stops.length - 1] = { ...stops.at(-1), ...arrival };
          const trip2 = this.trip(service, start), calls = stops.map((s, i) => this.call(s, service, trip2, at, i));
          const coordinates = calls.flatMap((c) => c.place.coordinate ? [c.place.coordinate] : []);
          const geometry2 = coordinates.length > 1 ? { type: "LineString", coordinates, quality: "schematic", evidence: sourceEvidence(at) } : null;
          const code = service.categoryCode;
          const mode = code === 6 ? "bus" : code === 9 ? "tram" : code === 4 ? "boat" : code === 7 ? "cableway" : [0, 1, 2, 3, 5, 8].includes(code) ? "train" : "unknown";
          legs.push({ ...base, kind: "ride", geometry: geometry2, mode, line: textValue(service.number), headsign: textValue(service.to), trip: trip2, calls, boardingCallId: calls[0].id, alightingCallId: calls.at(-1).id, boardingTarget: targetForCall(calls[0]), instructions: [{ id: `${legId}:board`, kind: "board", coordinate: null, text: `Check the vehicle destination ${textValue(service.to) ?? "on the departure display"} and source platform label before boarding. The waiting area is unverified.` }] });
        } else {
          legs.push({ ...base, kind: legs.length && list(raw.sections).slice(index + 1).some((s) => s.journey) ? "transfer" : "walk", geometry: null, distanceMeters: null, instructions: [{ id: `${legId}:walk`, kind: "unknown", coordinate: null, text: "The timetable includes this walk, but no verified pedestrian path or crossing instructions are available." }] });
        }
      }
      if (!legs.length) throw new ProviderError("provider_invalid", "No journey sections.");
      const connected = [];
      const gap = (from, to, start, end, kind, label) => ({ id: `${id}:${label}`, kind, from, to, plannedStart: start, plannedEnd: end, expectedStart: null, expectedEnd: null, geometry: null, instructions: [{ id: `${id}:${label}:instruction`, kind: "unknown", coordinate: null, text: "Access path and walking time are unavailable. Check local signs and allow additional time." }], distanceMeters: null, accessibility: "unknown", evidence: [{ source: "rightside:unresolved-walking-gap", fetchedAt: at, kind: "derived", quality: "unknown" }] });
      if (request.origin.id !== legs[0].from.id) {
        connected.push(gap(request.origin, legs[0].from, legs[0].plannedStart, legs[0].plannedStart, "walk", "access"));
        warnings.push("Access walking time is unknown and excluded from the displayed duration.");
      }
      for (const leg2 of legs) {
        const previous = connected.at(-1);
        if (previous && (previous.to.id !== leg2.from.id || previous.kind === "ride" && leg2.kind === "ride")) connected.push(gap(previous.to, leg2.from, previous.plannedEnd, leg2.plannedStart, "transfer", `transfer:${connected.length}`));
        connected.push(leg2);
      }
      const last = connected.at(-1);
      if (last.to.id !== request.destination.id) {
        connected.push(gap(last.to, request.destination, last.plannedEnd, last.plannedEnd, "walk", "egress"));
        warnings.push("Egress walking time is unknown and excluded from the displayed duration.");
      }
      return journeySchema.parse({ schemaVersion: 1, id, revision: 0, origin: request.origin, destination: request.destination, preferences: request.preferences, legs: connected, durationSeconds: (Date.parse(connected.at(-1).plannedEnd) - Date.parse(connected[0].plannedStart)) / 1e3, warnings, evidence: sourceEvidence(at) });
    }
  };
  function normalizePlaces(raw, fetchedAt) {
    if (!instant3(fetchedAt)) throw new Error("Invalid fetch timestamp");
    const data = record2(raw);
    if (data.errors || !Array.isArray(data.stations)) throw new Error("Transit source returned no valid place list");
    const places = list(data.stations).filter((p) => p.type !== "refine" && textValue(p.name)).map((p) => normalizePlace(p, fetchedAt));
    return [...new Map(places.map((p) => [p.id, p])).values()].slice(0, 30);
  }
  function normalizeConnections(raw, request, fetchedAt) {
    if (!instant3(fetchedAt)) throw new Error("Invalid fetch timestamp");
    const data = record2(raw);
    if (data.errors || !Array.isArray(data.connections)) throw new Error("Transit source returned no valid connection list");
    const journeys = [], warnings = [];
    for (const connection of list(data.connections).slice(0, 16)) {
      try {
        const journey2 = new LocalTransportNormalizer().connection(connection, request, fetchedAt);
        if (!journeys.some((j) => j.id === journey2.id)) journeys.push(journey2);
      } catch {
        warnings.push("A source itinerary was omitted because its times, stop order or endpoints could not be validated.");
      }
    }
    return { schemaVersion: 1, journeys, itineraryRefs: journeys.map(makeItineraryRef), generatedAt: fetchedAt, warnings: [...new Set(warnings)] };
  }

  // packages/walking/src/graph.ts
  function distanceMeters(a, b) {
    const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 63710088e-1 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function inside(coordinate2, b) {
    return coordinate2[0] >= b[0] && coordinate2[0] <= b[2] && coordinate2[1] >= b[1] && coordinate2[1] <= b[3];
  }

  // packages/walking/src/route.ts
  function segmentDistance(p, a, b) {
    const scale = Math.cos(p[1] * Math.PI / 180), x = (b[0] - a[0]) * scale, y = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * scale * x + (p[1] - a[1]) * y) / (x * x + y * y) || 0));
    return distanceMeters(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  }
  function snap(graph, endpoint, nodes) {
    if (!endpoint || typeof endpoint !== "object") return { status: "unavailable", reason: "invalid_endpoint" };
    if ("nodeId" in endpoint) {
      const node2 = nodes.get(endpoint.nodeId);
      return node2 ? { node: node2 } : { status: "unavailable", reason: "unknown_node" };
    }
    if (!coordinateSchema.safeParse(endpoint.coordinate).success || endpoint.level !== void 0 && typeof endpoint.level !== "string" || endpoint.accuracyMeters !== void 0 && (!Number.isFinite(endpoint.accuracyMeters) || endpoint.accuracyMeters < 0)) return { status: "unavailable", reason: "invalid_endpoint" };
    if (!inside(endpoint.coordinate, graph.bounds)) return { status: "unavailable", reason: "outside_pilot" };
    if ((endpoint.accuracyMeters ?? 0) > 3) return { status: "ambiguous", reason: "position_uncertainty" };
    const radius = 2 + (endpoint.accuracyMeters ?? 0);
    const candidates = graph.nodes.filter((n) => (endpoint.level === void 0 || n.level === endpoint.level) && distanceMeters(n.coordinate, endpoint.coordinate) <= radius);
    if (!candidates.length) return { status: "unavailable", reason: "no_safe_node_snap" };
    if (candidates.length !== 1) return { status: "ambiguous", reason: "multiple_path_or_floor_candidates" };
    const node = candidates[0];
    if (graph.edges.some((e) => {
      if (e.from === node.id || e.to === node.id) return false;
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (endpoint.level !== void 0 && a.level !== endpoint.level && b.level !== endpoint.level) return false;
      return segmentDistance(endpoint.coordinate, a.coordinate, b.coordinate) <= radius;
    })) return { status: "ambiguous", reason: "competing_path_near_endpoint" };
    return { node };
  }
  function closureState(closure, now) {
    const from = closure.validFrom === void 0 ? -Infinity : Date.parse(closure.validFrom);
    const until = closure.validUntil === void 0 ? Infinity : Date.parse(closure.validUntil);
    if (Number.isNaN(from) || Number.isNaN(until) || until <= from) return "active";
    return now < from ? "future" : now >= until ? "expired" : "active";
  }
  function routeWalk(graph, request) {
    const base = {
      schemaVersion: 1,
      status: "unavailable",
      reason: "no_path",
      geometry: null,
      instructions: [],
      distanceMeters: null,
      accessibility: "unknown",
      evidence: graph.evidence,
      warnings: [...graph.warnings],
      nodeIds: [],
      edgeIds: [],
      pedestrianTargetStatus: "unverified",
      currentAccess: "unknown"
    };
    if (!request || !Number.isFinite(Date.parse(request.now))) return { ...base, reason: "invalid_request_time" };
    const now = Date.parse(request.now), nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const from = snap(graph, request.from, nodes), to = snap(graph, request.to, nodes);
    if (!("node" in from)) return { ...base, status: from.status, reason: `from:${from.reason}` };
    if (!("node" in to)) return { ...base, status: to.status, reason: `to:${to.reason}` };
    const closures = request.closures ?? [], blocked = new Set(closures.filter((c) => closureState(c, now) === "active").map((c) => c.edgeId));
    const expired = new Set(closures.filter((c) => closureState(c, now) === "expired").map((c) => c.edgeId));
    const adjacency = /* @__PURE__ */ new Map();
    const add = (at, next, edge) => {
      const list2 = adjacency.get(at) ?? [];
      list2.push({ next, edge });
      adjacency.set(at, list2);
    };
    for (const edge of graph.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to) || !Number.isFinite(edge.lengthMeters) || edge.lengthMeters < 0 || edge.access !== "allowed" || blocked.has(edge.id)) continue;
      if ((request.stepFree || request.wheelchair) && edge.kind === "stairs") continue;
      if (request.wheelchair && edge.wheelchair === "no") continue;
      add(edge.from, edge.to, edge);
      if (edge.bidirectional) add(edge.to, edge.from, edge);
    }
    const distances = /* @__PURE__ */ new Map([[from.node.id, 0]]), previous = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Set([from.node.id]);
    while (pending.size) {
      let at = pending.values().next().value;
      for (const candidate2 of pending) if (distances.get(candidate2) < distances.get(at)) at = candidate2;
      pending.delete(at);
      if (at === to.node.id) break;
      for (const { next, edge } of adjacency.get(at) ?? []) {
        const cost = edge.lengthMeters * (request.wheelchair && edge.wheelchair === "unknown" ? 3 : 1) + (edge.kind === "lift" ? 20 : 0);
        const candidate2 = distances.get(at) + cost;
        if (candidate2 < (distances.get(next) ?? Infinity)) {
          distances.set(next, candidate2);
          previous.set(next, { nodeId: at, edge });
          pending.add(next);
        }
      }
    }
    if (!distances.has(to.node.id)) return base;
    const nodeIds = [to.node.id], path = [];
    while (nodeIds[0] !== from.node.id) {
      const entry = previous.get(nodeIds[0]);
      path.unshift(entry.edge);
      nodeIds.unshift(entry.nodeId);
    }
    const coordinates = nodeIds.map((id) => nodes.get(id).coordinate);
    if (coordinates.length === 1) coordinates.push(coordinates[0]);
    const evidence2 = [...graph.evidence, ...path.flatMap((e) => e.evidence), ...closures.filter((c) => path.some((e) => e.id === c.edgeId)).flatMap((c) => c.evidence)];
    const warnings = [...base.warnings];
    if (path.some((e) => expired.has(e.id))) warnings.push("Closure evidence expired on this path; expiry is not confirmation that access reopened.");
    if (path.some((e) => e.wheelchair === "unknown")) warnings.push("Wheelchair accessibility is incomplete or unknown on this path.");
    if (nodeIds.some((id) => nodes.get(id).level === null)) warnings.push("Some mapped paths have no explicit floor level.");
    return {
      ...base,
      status: "routed",
      reason: "mapped_path_found",
      geometry: { type: "LineString", coordinates, quality: "routed", evidence: evidence2 },
      distanceMeters: path.reduce((sum, e) => sum + e.lengthMeters, 0),
      nodeIds,
      edgeIds: path.map((e) => e.id),
      evidence: evidence2,
      warnings,
      // Even explicit yes tags do not certify current accessibility.
      accessibility: path.some((e) => e.wheelchair === "no") ? "no" : "unknown",
      instructions: path.map((e, i) => ({
        id: e.id,
        kind: e.kind,
        coordinate: nodes.get(nodeIds[i]).coordinate,
        text: e.kind === "crossing" ? "Use the mapped crossing; check local access and traffic." : e.kind === "stairs" ? "Use the mapped stairs." : e.kind === "lift" ? "Use the mapped lift if available." : `Follow the mapped pedestrian path${e.tags.name ? ` (${e.tags.name})` : ""}.`
      }))
    };
  }

  // packages/ios-bridge/src/walking.ts
  function routeLocalWalk(graph, request) {
    if (!graph || graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 1e4 || graph.edges.length > 2e4 || !Array.isArray(graph.bounds) || graph.bounds.length !== 4 || graph.bounds.some((n) => !Number.isFinite(n)) || !Array.isArray(graph.warnings) || graph.warnings.some((s) => typeof s !== "string") || !Array.isArray(graph.evidence)) throw new Error("Invalid bounded walking graph");
    graph.evidence.forEach((e) => evidenceSchema.parse(e));
    const nodes = /* @__PURE__ */ new Set();
    for (const node of graph.nodes) {
      if (typeof node.id !== "string" || nodes.has(node.id) || node.level !== null && typeof node.level !== "string") throw new Error("Invalid walking node");
      coordinateSchema.parse(node.coordinate);
      nodes.add(node.id);
    }
    const edges = /* @__PURE__ */ new Set();
    for (const edge of graph.edges) {
      if (typeof edge.id !== "string" || edges.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || !Number.isFinite(edge.lengthMeters) || edge.lengthMeters < 0 || !["walk", "crossing", "stairs", "lift"].includes(edge.kind) || !["yes", "no", "unknown"].includes(edge.wheelchair) || !["allowed", "restricted", "unknown"].includes(edge.access) || typeof edge.bidirectional !== "boolean" || !Array.isArray(edge.evidence)) throw new Error("Invalid walking edge");
      edges.add(edge.id);
      edge.evidence.forEach((e) => evidenceSchema.parse(e));
    }
    if (request?.closures !== void 0) {
      if (!Array.isArray(request.closures)) throw new Error("Invalid walking closures");
      for (const closure of request.closures) {
        if (!closure || typeof closure.edgeId !== "string" || !Array.isArray(closure.evidence)) throw new Error("Invalid walking closure");
        closure.evidence.forEach((e) => evidenceSchema.parse(e));
      }
    }
    return routeWalk(graph, request);
  }

  // packages/ios-bridge/src/index.ts
  function state(value) {
    return restoreNavigation(JSON.stringify(value));
  }
  function replay2(value) {
    const fixture = replayFixtureSchema.parse(value.fixture);
    const navigation = state(value.navigation);
    if (!Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor > fixture.events.length || !["outbound", "return"].includes(value.direction) || typeof value.paused !== "boolean" || !Number.isFinite(value.speed) || value.speed <= 0 || value.speed > 1e3) throw new Error("Invalid replay cursor");
    const expected = value.direction === "outbound" ? fixture.journey : fixture.returnJourney;
    if (navigation.journey.id !== expected.id) throw new Error("Replay journey mismatch");
    return { fixture, navigation, cursor: value.cursor, direction: value.direction, paused: value.paused, speed: value.speed };
  }
  function event2(s, type, data, now, evidenceKind = "manual") {
    return navigationEventSchema.parse({ schemaVersion: 1, id: `ios:${s.journey.id}:${s.lastSequence + 1}:${now}`, sequence: s.lastSequence + 1, at: now, journeyId: s.journey.id, legId: currentLeg(s).id, type, data, evidence: [{ source: "rightside:ios", fetchedAt: now, observedAt: now, kind: evidenceKind, quality: "supported" }] });
  }
  function dispatch(method, p) {
    switch (method) {
      case "validateJourney":
        return journeySchema.parse(p.journey);
      case "routeWalk":
        return routeLocalWalk(p.graph, p.request);
      case "validatePlace":
        return placeSchema.parse(p.place);
      case "validateVisualPose":
        return visualPoseObservationSchema.parse(p.observation);
      case "validateFixture":
        return replayFixtureSchema.parse(p.fixture);
      case "normalizePlaces":
        return normalizePlaces(p.raw, p.fetchedAt);
      case "normalizeConnections":
        return journeySearchResponseSchema.parse(normalizeConnections(p.raw, journeySearchRequestSchema.parse(p.request), p.fetchedAt));
      case "create":
        return createNavigationState(journeySchema.parse(p.journey), p.now);
      case "reduce":
        return reduceNavigation(state(p.state), navigationEventSchema.parse(p.event));
      case "confirm": {
        const s = state(p.state);
        return reduceNavigation(s, event2(s, "user_confirmed", { action: p.action, reason: p.reason ?? "Explicit native user confirmation" }, p.now));
      }
      case "connectivity": {
        const s = state(p.state);
        return reduceNavigation(s, event2(s, "connectivity_changed", { online: p.online, reason: "Native connectivity state" }, p.now));
      }
      case "location": {
        const s = state(p.state);
        return reduceNavigation(s, event2(s, "location_observed", positionEstimateSchema.parse(p.position), p.now, "observed"));
      }
      case "vision": {
        const s = state(p.state), observation = visionObservationSchema.parse(p.observation);
        return reduceNavigation(s, event2(s, "vision_observed", { observation, match: { legId: currentLeg(s).id, trackId: observation.trackId, status: "unknown", reasonCodes: ["native_observation_requires_domain_match"], observationIds: [observation.id], expiresAt: observation.expiresAt, evidence: observation.evidence } }, p.now, "observed"));
      }
      case "tick":
        return advanceNavigationClock(state(p.state), p.now);
      case "prepareAlighting":
        return prepareAlighting(state(p.state), p.now);
      case "correct":
        return correctProgress(state(p.state), p.correction, p.now);
      case "replan":
        return acceptReplan(state(p.state), journeySchema.parse(p.journey), p.now);
      case "return":
        return startReturnJourney(state(p.state), journeySchema.parse(p.journey), p.now);
      case "refresh":
        return refreshJourney(state(p.state), journeySchema.parse(p.journey), p.now);
      case "refreshAvailability":
        return { schemaVersion: 1, status: "snapshot_unavailable", journey: null, events: [], generatedAt: p.now };
      case "serialize":
        return serializeNavigation(state(p.state));
      case "restore":
        return restoreNavigation(p.json);
      case "createReplay":
        return createReplay(replayFixtureSchema.parse(p.fixture));
      case "advanceReplay":
        return advanceReplay(replay2(p.replay), p.elapsedMs);
      case "nextReplay": {
        const r = replay2(p.replay);
        const next = r.fixture.events.slice(r.cursor).find((e) => e.journeyId === r.navigation.journey.id);
        return next ? advanceReplay({ ...r, paused: false }, Math.max(0, Date.parse(next.at) - Date.parse(r.navigation.now)) / r.speed) : r;
      }
      case "returnReplay":
        return startReplayReturn(replay2(p.replay));
      case "restoreReplay":
        return replay2(p.replay);
      default:
        throw new Error(`Unknown bridge method: ${method}`);
    }
  }
  function call2(method, payloadJSON) {
    try {
      const payload = JSON.parse(payloadJSON);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected object payload");
      return JSON.stringify({ ok: true, value: dispatch(method, payload) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: { code: "invalid_bridge_request", message: error instanceof Error ? error.message : String(error) } });
    }
  }
  return __toCommonJS(index_exports);
})();
