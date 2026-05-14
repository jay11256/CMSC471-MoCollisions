The Montgomery County, MD open-data portal publishes every police-reported
crash with information about weather, lighting, driver state, vehicle type,
collision geometry, and outcome severity. This dashboard turns that ~88 MB
CSV into a single coordinated view that answers questions like:

- **Where in the county do crashes concentrate?** -> a ZIP-code choropleth
  with a hex-density alternate view.
- **When are people crashing?** -> a year-by-month time series and a
  hour x day-of-week heatmap.
- **What makes a crash worse?** -> a *risk-factor lift chart* that shows,
  e.g., how much more often crashes turn serious or fatal when alcohol or
  drugs are suspected vs. the overall baseline rate.
- **What's driving the totals?** -> stacked severity bars broken down by
  weather, light, road surface, collision type, distraction, substance,
  vehicle type, or speed limit.

Every panel cross-filters every other panel. Click a year, a ZIP, a heatmap
cell, a collision type, an hour bar, a chip - the whole dashboard updates
to that slice, and the auto-generated insights panel rewrites itself to
explain what changed.


## Team Contribution Breakdown:

Charles Phan
    Early brainstorming (what questions the dashboard should actually answer and which visualizations are most suitable)
    Implemented initial visualizations (bar charts) and filters
    Documentation (this README.md)

Jason Liu
    Setup of project repo and skeleton
    Preprocessed (filtering, aggregation) data for easier selection and summarization
    Implemented early visualizations (bar charts and severity breakdown) and filters


Dheer Guda
    Displayed the summary stats panel (total crashes, fatalities, distraction rate, etc.) and takeaways panel (at the bottom) for easier interpretation of data
    Implemented the heatmap (cloropleth) visualization, as well as more bar charts and the "When crashes happen" heatmap
    Reformatted the page for a cleaner look

Raghav Chakravarthy
    Improved color-coding
    Implemented the heatmap (hex density) and severity breakdown visualizations
    Fixed bugs with filtering and coloring




## Data Source

[Montgomery County Maryland - Crash Reporting Incidents Data](https://catalog.data.gov/dataset/crash-reporting-incidents-data)

## Tech

- [D3 v7](https://d3js.org/) and [d3-hexbin](https://github.com/d3/d3-hexbin)
- [Bootstrap 5](https://getbootstrap.com/) (utility classes only)
- [OpenDataDE Maryland ZIP-code GeoJSON](https://github.com/OpenDataDE/State-zip-code-GeoJSON)
- Vanilla JS + pandas/shapely for preprocessing
