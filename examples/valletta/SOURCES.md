# Valletta: the sources of its map

Written by `build.mjs valletta` from `cities/valletta.json`. Do not edit: change the spec and build again.

## Credits for the description of a film

A film that shows these layers carries these lines in its description (those under "Map data" must be there; the last line is a courtesy):

```
Map data:
Built-up areas: GHS-BUILT-S R2023A, Global Human Settlement Layer, European Commission, Joint Research Centre.
Elevation and water: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.
Made with Natural Earth.
```

| Source | Licence | Credit | Terms |
|---|---|---|---|
| Global Human Settlement Layer (GHS-BUILT-S R2023A) | free and open: "reuse of this data is authorised with proper acknowledgment of the source" (European Commission) | required: Built-up areas: GHS-BUILT-S R2023A, Global Human Settlement Layer, European Commission, Joint Research Centre. | https://human-settlement.emergency.copernicus.eu/download.php |
| Copernicus DEM GLO-30 | free of charge with attribution (Copernicus DEM licence) | required: Elevation and water: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. | https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM |
| Natural Earth | public domain | not required: Made with Natural Earth. | https://www.naturalearthdata.com/about/terms-of-use/ |

## Where each layer comes from

| Layer | Source | How |
|---|---|---|
| `region` | Natural Earth | Natural Earth 5.1.2, 1:10m: land, countries, boundary lines, rivers and lakes |
| `city.water, city.islands, city.rivers` | Copernicus DEM GLO-30 | the water body mask of the Copernicus DEM GLO-30 (ocean, lake, river) |
| `city.relief` | Copernicus DEM GLO-30 | Copernicus DEM GLO-30 (a surface model: it includes buildings), smoothed over 180 m |
| `city.builtUp` | Global Human Settlement Layer (GHS-BUILT-S R2023A) | the built-up surface of the Global Human Settlement Layer (GHS-BUILT-S R2023A, 100 m) of 1975, 2020: ground built on from 20 % up, gaps under 700 m closed, the piece round the centre traced |

## What rests on which source, and what was drawn by hand

- **Water** (`city.water, city.islands, city.rivers`)
  - every source is filled into one grid of 15 m and its outline traced, so a river mapped in pieces comes out whole
- **Valletta in 1975 (AD 1975)** (`city.epochs: y1975`): The built-up city of 1975 as satellite images show it (the Global Human Settlement Layer).
  - the built-up land of 1975 (city.builtUp)
- **Valletta in 2020 (AD 2020)** (`city.epochs: y2020`): The built-up city of 2020 as satellite images show it (the Global Human Settlement Layer).
  - the built-up land of 2020 (city.builtUp)

## The downloads

The pipeline fetched these; `sources.lock.json` holds the request and the SHA-256 of each. The files themselves are in `cache/`, which is not committed.

| Download | Source | Size | SHA-256 | Data of |
|---|---|---|---|---|
| `copernicus-glo30-35-14` | Copernicus DEM GLO-30 | 1394973 | `5cf508b5e8e699ab` | 2011-2015 |
| `copernicus-wbm-35-14` | Copernicus DEM GLO-30 | 79893 | `05137cc7868aa7a9` | 2011-2015 |
| `ghsl-built-s-1975-r5-c20` | Global Human Settlement Layer (GHS-BUILT-S R2023A) | 8107623 | `e1ce29d8754263e9` | 1975 (release R2023A) |
| `ghsl-built-s-2020-r5-c20` | Global Human Settlement Layer (GHS-BUILT-S R2023A) | 9866105 | `11aff3296bcfdaba` | 2020 (release R2023A) |
| `ne_10m_admin_0_boundary_lines_land` | Natural Earth | 2284669 | `74d9c16229c095fd` | 5.1.2 |
| `ne_10m_admin_0_countries` | Natural Earth | 13287234 | `239eec57ac17f100` | 5.1.2 |
| `ne_10m_lakes` | Natural Earth | 5043554 | `2d036f53dedec578` | 5.1.2 |
| `ne_10m_land` | Natural Earth | 10157965 | `1ac90796408bc6ad` | 5.1.2 |
| `ne_10m_rivers_lake_centerlines` | Natural Earth | 7307743 | `bb854a900ecbd3b4` | 5.1.2 |
