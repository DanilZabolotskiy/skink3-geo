# The Earth: the sources of its layers

Written by `globe.mjs`. Do not edit: build again with other options.

## Credits for the description of a film

A film that shows these layers may carry this line in its description (a courtesy: the data is in the public domain):

```
Made with Natural Earth.
```

| Source | Licence | Credit | Terms |
|---|---|---|---|
| Natural Earth | public domain | not required: Made with Natural Earth. | https://www.naturalearthdata.com/about/terms-of-use/ |

## What each layer is made of

| Layer | Source | How |
|---|---|---|
| `land` | Natural Earth 5.1.2, 1:110m land | made whole on the sphere (the cut along the south pole and down the 180th meridian taken out), thinned to 0.08° of arc, polygons under 300 km² left out |
| `lakes` | Natural Earth 5.1.2, 1:110m lakes | as the land; lakes under 4000 km² left out |
| `ice` | Natural Earth 5.1.2, 1:110m glaciated areas and 1:50m Antarctic ice shelves | as the land; ice under 300 km² left out |
| `places` | Natural Earth 5.1.2, 1:10m populated places | the towns of at least 200000 people (their greatest population), the largest first |

## The downloads

The build fetched these; `sources.lock.json` holds the request and the SHA-256 of each. The files themselves are in `cache/`, which is not committed.

| Download | Source | Size | SHA-256 | Data of |
|---|---|---|---|---|
| `ne_110m_land` | Natural Earth | 138160 | `9e0729ee253ca7d7` | 5.1.2 |
| `ne_110m_lakes` | Natural Earth | 36648 | `eb02ecc86c82004f` | 5.1.2 |
| `ne_110m_glaciated_areas` | Natural Earth | 21720 | `e61e3f45e22f087f` | 5.1.2 |
| `ne_50m_antarctic_ice_shelves_polys` | Natural Earth | 131055 | `fedf866d20e20e37` | 5.1.2 |
| `ne_10m_populated_places_simple` | Natural Earth | 4932147 | `fd3fa867a320cbd5` | 5.1.2 |
