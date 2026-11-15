# LineCheck
Fishing Area and regulations checker

## Security notes
- Static site, no backend, no accounts. Your GPS position is evaluated on the phone and never sent anywhere (map tile requests reveal only which map area is being viewed, as with any web map).
- All text from CDFW/Commons is HTML-escaped before display; links are limited to wildlife.ca.gov; a Content-Security-Policy blocks scripts from anywhere but this site.
- Raw third-party downloads (`raw/`) are kept for change tracking but excluded from GitHub Pages (`_config.yml`).
- GIS data is only accepted from CDFW's own ArcGIS organization and must pass size sanity checks.
- GitHub Actions are pinned to commit SHAs; Python packages are pinned in `requirements.txt`.
- Scheduled data refreshes go to the `data-refresh` branch and need approval before reaching `main`.
