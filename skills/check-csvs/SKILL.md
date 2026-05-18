---
name: check-csvs
description: Use when the user wants a data-quality review of the generated CSV files in public/, especially after fetch-data or stitching changes. Audit the current CSV set for duplicates, date/order issues, suspicious jumps, stitch-boundary continuity, and cross-file consistency using DataFetch.md and scripts/fetch-data.ts as the source of truth.
---

# Check CSVs

Use this skill to sanity-check the generated CSV files in `public/`.

Current files to audit:

- `etf-upro.csv`
- `etf-tqqq.csv`
- `etf-sso.csv`
- `etf-qld.csv`
- `index-sp.csv`
- `index-nq.csv`
- `risk-sgov.csv`
- `risk-vgsh.csv`
- `risk-gldm.csv`
- `risk-brka.csv`
- `rate-borrow.csv`
- `inflation.csv`

Do not expect `rate-tbill-1m.csv` or `rate-treasury-2y.csv`; those were removed.

## Source of truth

Before reviewing anomalies, read:

- `DataFetch.md`
- relevant sections of `scripts/fetch-data.ts`

If the prompt, docs, and code disagree, treat the code as the source of truth.

## Checks

1. Structural sanity
   - No duplicate dates.
   - Dates strictly increase.
   - Expected columns exist for each file type.
   - Values are finite and positive where required.

2. Gap sanity
   - Daily files: gaps should be plausible market/weekend/holiday gaps.
   - Inflation: monthly cadence should be consistent.
   - Flag long unexplained gaps.

3. Stitch-boundary continuity
   - Focus on source/name transitions, not normal movement inside one segment.
   - Check that boundary prices are continuous after scaling.
   - Use `name` and `source` changes plus `fetch-data.ts` boundary logic to identify expected stitch points.

4. Suspicious jumps
   - ETFs / indices: flag implausible one-day jumps.
   - SGOV / VGSH: very small daily moves expected.
   - GLDM: moderate commodity moves only.
   - Borrow rate / inflation: gradual changes expected.
   - Use common sense; review context before calling a move wrong.

5. Cross-file consistency
   - Leveraged ETFs should broadly move with their underlying index direction.
   - SGOV and VGSH should look treasury-like.
   - Stitched proxy behavior should make sense relative to the live asset after transitions.

## Review method

- Start with lightweight checks:
  - header
  - first/last rows
  - duplicate dates
  - largest daily moves
  - source/name transitions
- Then inspect only the suspicious windows in detail.
- Prefer explaining whether an anomaly is:
  - expected by stitch design
  - a likely data bug
  - or uncertain and needs manual verification

## Output

For each issue found, report:

1. file
2. issue type
3. exact date/rows involved
4. why it is suspicious
5. likely fix or next verification step

If no issues are found, say that explicitly and mention what you checked.
