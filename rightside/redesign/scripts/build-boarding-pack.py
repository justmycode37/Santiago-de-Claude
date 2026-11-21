#!/usr/bin/env python3
"""Build the bounded Bern pack from an actual official atlas CSV snapshot.
The point coordinates are NOT surveyed pedestrian polygons. Never synthesize them.
Re-run daily with a newly downloaded actual-date CSV (official update interval).
"""
import csv
import datetime as dt
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'research/traffic-points.csv'
now = dt.datetime.now(dt.timezone.utc)
records = []
for row in csv.DictReader(source.open(encoding='utf-8-sig'), delimiter=';'):
    try:
        lat, lon = float(row['wgs84North']), float(row['wgs84East'])
    except (ValueError, KeyError):
        continue
    if not (46.925 <= lat <= 46.975 and 7.40 <= lon <= 7.49):
        continue
    if row['trafficPointElementType'] != 'BOARDING_PLATFORM' or row['status'] != 'VALIDATED':
        continue
    records.append(dict(id=row['sloid'], stopID=row['parentSloidServicePoint'],
                        name=row['designationOfficial'], label=row['designation'] or row['designationOperational'],
                        latitude=lat, longitude=lon,
                        directionDegrees=float(row['compassDirection']) if row['compassDirection'] else None,
                        validFrom=row['validFrom'], validUntil=row['validTo'],
                        sourceEditedAt=row['editionDate'], pedestrianArea=None, accuracyMeters=None))
pack = dict(schemaVersion=1, id='bern-atlas-boarding', version=now.strftime('%Y%m%d'),
            fetchedAt=now.isoformat(), expiresAt=(now+dt.timedelta(days=1)).isoformat(),
            source='https://data.opentransportdata.swiss/dataset/traffic-point-v2',
            license='https://opentransportdata.swiss/de/terms-of-use/',
            attribution='Source: opentransportdata.swiss / atlas (SKI). Bern subset prepared by RightSide.',
            sourceSHA256=hashlib.sha256(source.read_bytes()).hexdigest(),
            coverage=[7.40,46.925,7.49,46.975], boardingPoints=records)
target = root / 'apps/ios/RightSide/Resources/TransportPacks/bern-boarding.json'
target.write_text(json.dumps(pack, ensure_ascii=False, indent=2)+'\n')
print(f'{len(records)} official boarding points; 0 surveyed pedestrian areas; {target.stat().st_size} bytes')
