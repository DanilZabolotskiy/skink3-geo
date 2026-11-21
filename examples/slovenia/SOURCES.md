# Slovenia: the sources of its layers

Written by `world.mjs`. Do not edit: build again with other options.

## Credits for the description of a film

A film that shows these layers may carry this line in its description (a courtesy: the data is in the public domain):

```
Made with Natural Earth.
```

| Source | Licence | Credit | Terms |
|---|---|---|---|
| Natural Earth | public domain | not required: Made with Natural Earth. | https://www.naturalearthdata.com/about/terms-of-use/ |

## What each layer is made of

The map shows the box 8.5, 42.6, 21.5, 49.6 on the azimuthal equal-area plane round 15, 46.1, in metres.

| Layer | Source | How |
|---|---|---|
| `countries` | Natural Earth 5.1.2, 1:10m admin-0 countries | thinned together to 277 m, so neighbours keep one border, cut to the box; islands under 2.762 km² left out, but every country keeps its largest piece |
| `land`, `gaps` | the same countries as one | the coast: the edges of the countries that no neighbour shares; the gaps are the water inside the land that no country holds |
| `boundaries` | the same countries | the edges two countries share, each border once |
| `lakes` | Natural Earth 5.1.2, 1:10m lakes | the lakes of rank 6 and below, thinned to 277 m, cut to the box; lakes under 2.762 km² left out |

## The downloads

The build fetched these; `sources.lock.json` holds the request and the SHA-256 of each. The files themselves are in `cache/`, which is not committed.

| Download | Source | Size | SHA-256 | Data of |
|---|---|---|---|---|
| `ne_10m_admin_0_countries` | Natural Earth | 13287234 | `239eec57ac17f100` | 5.1.2 |
| `ne_10m_lakes` | Natural Earth | 5043554 | `2d036f53dedec578` | 5.1.2 |
