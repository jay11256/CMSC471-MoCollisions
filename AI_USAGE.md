# AI tools used in this project

I used **Cursor with Claude (Opus / Sonnet variants)** as a pair programmer
for the entire build. The chat transcripts are preserved in the project's
agent-transcript folder. This document is the public record of how the
tools were used, what they did well, and what I changed by hand.

## Tasks where AI did most of the typing

1. **Data exploration**
   *Prompt direction:* "Look through the entire project and especially
   `data/Crash_Reporting.csv` and really understand what's in that data."
   The model spent its first turns running pandas one-liners to inspect
   column distributions (severity, weather, light, collision type,
   distraction, substance, surface, route, speed limit), and discovered
   the data is from **Montgomery County, MD, 2015 - 2025**, with the
   capitalisation inconsistency that motivated the bucketing step.

2. **Category bucketing (`preprocess.py`)**
   The CSV ships with two formatting eras concatenated (`"DARK LIGHTS ON"`
   vs. `"Dark - Lighted"`), 16 light categories, 28 collision types, etc.
   I asked the model to draft a function per column that collapses the
   noise into a small fixed set; I reviewed and adjusted a few buckets
   (e.g. keeping "Sleet / Ice" separate from "Snow"). The
   `severity` / `weather` / `light` / `surface` / `collision` /
   `distraction` / `substance` / `vehicle` helpers are essentially the
   draft from that turn.

3. **Encoding to integers + summary.json**
   I asked for the cleaned data to be written as a small integer-encoded
   CSV plus a sidecar JSON with the category names, which dropped the
   file from 88 MB -> 12 MB.

4. **ZIP-code choropleth pipeline**
   The model fetched the OpenDataDE Maryland ZIP GeoJSON, filtered it to
   Montgomery County by lat/lon bounding box, built a Shapely STRtree
   index, and assigned every crash to a ZIP via point-in-polygon.

5. **Dashboard scaffolding**
   The first pass of `index.html` (filter rail + KPI cards + grid of
   panels) and `css/styles.css` (dark theme, glass cards, severity
   palette) came from a single "design me a polished cross-filter
   dashboard" prompt. I changed the colour palette, added the active-
   filter chip row, and reworked the map's two-mode header.

6. **D3 charts**
   Each chart function in `js/script.js` (map, time series, heatmap,
   stacked bar, collision bar, hourly bar coloured by severity rate,
   vehicle bar, **risk-factor lift**) was prompted individually with
   the data shape and the desired interactions, then iterated on:
   - Fixing the brush + hover overlap on the time-series.
   - Adding the active-chip "x" remove handler and the
     `syncRailChips()` helper.
   - Making the `Other / Unknown` categories drop out of the risk
     chart instead of dominating it.

7. **Auto-generated insights**
   The insights panel started out as plain summary statistics. I
   asked for a redesign that compares the filtered slice's
   severity / substance / distraction shares to the dataset-wide
   baseline and uses colour-coded callouts (`warn` / `danger` /
   `good`). The "From 2015 to 2025, total crashes fell by X%"
   sentence came from a follow-up turn that explicitly asked for a
   trend-aware insight.

## Things I did by hand

- Reviewed all of the bucketing rules and added or split a few
  categories the model didn't think of (e.g. keeping `Severe Winds`
  separate, mapping `Looked but did not see` to its own distraction
  bucket because it appears in the top-5).
- Trimmed the GeoJSON precision (4 decimals) and confirmed the file
  still drew cleanly at the chosen zoom.
- Reworked the colour scale: the model originally chose `viridis`
  for the choropleth; I swapped to `YlOrRd` because the "more crashes
  = redder" reading is more intuitive for a safety dashboard.
- Tuned the cross-filter UX: ZIP click toggles, heatmap-cell click
  toggles only the day-of-week, the time-of-day input writes through
  to `state.filters.hourStart/End`, etc.
- Caught a bug where clicking a ZIP filter combined with a year
  filter could produce zero crashes - added a friendly fallback in
  `drawRisk` for that case.
- Built the headless-Chrome smoke test (`test_dashboard.mjs`) to
  validate that every panel renders, the metric toggles change the
  fills, and the reset button clears everything.

## Prompts that worked particularly well

- *"What columns in this CSV explain crash outcomes? Run pandas
  `value_counts()` on every reasonable column."* - the model
  produced a long, useful catalog of the dimensions worth visualising.
- *"Design a single-page D3 dashboard for this data with a map, time
  series, heatmap, factor breakdown, and a risk-factor lift chart.
  All views should cross-filter from one state object. Use a dark
  theme."* - this gave the basic file shape that the rest of the
  project iterated on.
- *"Write a function `drawRisk` that, for each category of
  `state.riskBy`, plots how much more often the severity is serious
  or fatal compared to the baseline rate. Ignore categories with
  fewer than 50 crashes. Use a vertical reference line at lift=1."* -
  produced the **most distinctive** chart in the dashboard on the
  first try.

## Prompts I had to retry

- The first stacked-bar drew the segments using `d3.stack()` data
  but didn't preserve the severity order; I rewrote it as a simple
  per-row manual layout so the colour order matches the legend.
- Map projection initially called `d3.geoMercator().fitExtent(...)`
  with the *crashes* GeoJSON-like array instead of the ZIP feature
  collection, which produced a wildly stretched map; fixed in one
  turn by clarifying the input.

## Reflections

Using Claude through Cursor felt closest to pairing with a competent
collaborator who is shy about asking what colour palette I want. The
biggest win was doing the data-shape spelunking in seconds rather
than hours: the model could run pandas commands and read the results
without me writing throwaway scripts. The biggest pitfall was that
the model loved to introduce abstractions (custom `stackedSeries()`,
class hierarchies) that I had to push back on - this dashboard is
better as a flat, readable file.
