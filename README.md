# skink3-geo

Real geographic data turned into the simplified vector layers a city's map is drawn from: the country round it, the sea and the rivers in their true width, the relief, walls, main streets, the built-up land, and the city's outline through time, ready to grow from one epoch into the next. One spec a city, one command, and the same bytes every time, with the credit of every source written out.

It is made for animated maps (the scenes of [skink3-engine](https://github.com/DanilZabolotskiy/skink3-engine) among them), but it draws nothing and depends on no renderer: its output is one JSON file of points in metres.

```
build.mjs, lib/             the pipeline: plain Node, no package needed to build
map.ts                      for a scene: the types of the layers, loading, the fit into a stage
test/                       the tests
examples/                   a root of cities, with one small city built: Valletta
  cities/<city>.json        the spec: the frames, the layers wanted, the epochs and their sources
  <city>/layers.json        the layers: the only file a scene reads
  <city>/SOURCES.md         where each layer comes from, what was drawn by hand, the credit lines
  <city>/sources.lock.json  every download: its request, its SHA-256, its size, its date
  cache/, out/              not in git: the raw downloads, and the previews
```

```
npm ci                                                  # the pinned packages (the canvas of the previews, the type checker)
node build.mjs valletta --root examples --preview       # build; download what the cache lacks; draw the previews
node build.mjs valletta --root examples --offline       # build from the cache alone
node build.mjs valletta --root examples --update        # take a source that has changed since the lock
npm run check                                           # the type check and the tests
```

`--root` is the directory that holds `cities/` (the working directory when it is not given). The previews, 1920 x 1080, go to `out/<city>/`: `region.png`, `city-<view>.png`, `hills.png`, `epochs-morph.png`, `epochs-morph-whole.png`. They check that every layer is in its place. They are not a design.

## A new city

One command takes a city, its box and the years wanted, and gives its layers:

```
node build.mjs valletta --root examples --new --name Valletta --country MLT \
  --bbox 14.31,35.79,14.59,35.99 --centre 14.5146,35.8989 --years 1975,2020 --preview
```

`--new` writes `cities/<city>.json` once (it never overwrites a spec) and builds it. `--bbox` is west,south,east,north in degrees; `--centre` (the middle of the box by default) is the `[0, 0]` of the city's plane; `--country` is the ISO A3 code of the country to mark in the region; `--years` are years of the built-up layer (every fifth from 1975 to 2030; after 2020 a projection). What it gives rests on sources that cover the whole world, so it builds for any city: the region, the sea, lakes and wide rivers, contour lines every 50 m, and the built-up city of each year as an epoch. The example is exactly that, untouched.

What a history needs beyond that is added to the spec by hand ("The spec" below): a closer view, the rivers by name, the hills, the walls, the main streets, the epochs before 1975 with a source for each, the landmarks. Then the same command without `--new` builds it again.

## In a project of its own

A project keeps its cities with itself (its specs, its layers, its cache) and calls the pipeline from a script of a few lines:

```js
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'skink3-geo/build.mjs';

process.exitCode = await run(process.argv.slice(2), {
  root: dirname(fileURLToPath(import.meta.url)),   // holds cities/, receives <city>/, cache/ and out/
  command: 'maps/build.mjs',                       // how the build is called there: the usage line, the head of SOURCES.md
  sources: { own: { name: 'Drawn for this project' } },   // changes to the table of sources, by key and field
  notes: ['A paragraph of the project\'s own terms, set after the credits in SOURCES.md.'],
});
```

The layers are a function of the spec, the downloads and this code, so a project pins the commit of this repository it builds with.

## The layers: format `cities-geo/1`

Every coordinate is **metres on a plane**, x east and y north of the centre of its frame (a Lambert azimuthal equal-area projection on the sphere, centred on the frame: true to scale at a city, within a few parts in a thousand over a country). A ring is a closed outline, a list of `[x, y]` without the first point repeated, counter-clockwise, which never crosses itself. A line is an open list of points.

There are two frames, each with its own centre, so the points of one are not those of the other:

| Frame | Holds | Detail |
|---|---|---|
| `frames.region` | `region.*`: the country and the land and sea round it | points to 1 m; bends smaller than 1/2200 of the box's height are smoothed away (about 550 m in a box of 1200 km) |
| `frames.city` | `city.*`: the city | points to 0.1 m, bends under a few metres smoothed away |

A frame gives its `centre` (`[lon, lat]`), its `box` in metres (`[x0, y0, x1, y1]`) and the same in degrees (`lonlat`). The city frame also gives `views`, the named boxes of the spec in metres: the whole of the city, and, where a spec adds one, a closer view of its middle.

| Layer | What it is |
|---|---|
| `region.land[]` | `{ id, ring }`: all the land in the box, cut to the box. The sea is what the land leaves |
| `region.country` | `{ id, name, rings[] }`: the country, its islands too |
| `region.borders[]` | `{ id, with, lines[] }`: its land borders, one entry a neighbour |
| `region.rivers[]`, `region.lakes[]` | `{ id, name, lines[] }` and `{ id, name, ring }` |
| `region.city` | `{ id, name, at }`: the city in the region's frame |
| `city.water[]` | `{ id, areaHa, ring }`: water as whole forms, the largest first: a river with its two banks, a lake, the sea |
| `city.islands[]` | `{ id, areaHa, ring }`: islands, drawn over the water |
| `city.rivers[]` | `{ id, name, lengthKm, lines[] }`: a river as a line down its middle, for a far view or a flow |
| `city.relief.contours[]` | `{ id, height, rings[], lines[] }`: contour lines at the heights the spec chose. A line is a contour the box cuts |
| `city.relief.hills[]` | `{ id, name, summit, centre, height, areaHa, rings[] }`: each hill a soft form of its own. `rings` go from its foot up, `{ height, ring }`, each inside the one before. `centre` is where its mark or label belongs |
| `city.walls[]` | `{ id, name, built, lengthKm, areaHa, ring }`: a wall as its whole closed circuit |
| `city.streets[]` | `{ id, class, name?, ref?, from?, to?, lengthKm, lines[] }`: main streets, the widest class first; `from` and `to` are the years a street stood, where the source dates it |
| `city.builtUp[]` | `{ id, year?, areaHa, ring, pieces[] }`: the built-up city of a year, the earliest first. `ring` is the body that holds the centre; `pieces` are the other large bodies, which a strait or a valley parts from it |
| `city.epochs[]` | `{ id, year, name, areaHa, ring, morph }`: the city's outline through time, the earliest first; a year BC is negative |
| `city.landmarks[]` | `{ id, name, built?, at, lonlat }` |

**The morph.** Every epoch of a city has a second outline, `morph`, of the same number of points (160) set at equal steps along it, counter-clockwise and turned so that point *k* of one epoch lies nearest to point *k* of the next. A scene that draws the two as one region with the same point count grows the city from one epoch into the next with no further work. An outline with far more detail than 160 points can hold (a city of today, with its inlets and arms) is calmed first, so its `morph` follows its body and its `ring` keeps the detail.

Heights come from a surface model, so they include buildings, and are smoothed: a hill's `height` is good to a few metres and is not a figure to put on screen.

## In a scene

`map.ts` reads the layers and fits them into a stage. It draws nothing and names no colour.

```ts
import { fitView, linesOnStage, loadLayers, morphOnStage, ringsOnStage } from 'skink3-geo';

const town = loadLayers(new URL('./valletta/layers.json', import.meta.url));
const view = fitView(town.frames.city.views.metro!, { w: 1920, h: 1080 });       // the stage's [0, 0] is its middle
const water = ringsOnStage(view, town.city.water!.map((f) => f.ring));           // the points of closed regions
const heights = linesOnStage(view, town.city.relief!.contours[0]!.lines);        // the points of open strokes
const grow = morphOnStage(view, town.city.epochs![0]!, town.city.epochs![1]!);   // grow.at(t), t from 0 to 1
```

- `fitView(box, { w, h, at? }, { mode?, zoom?, shift? })` shows a box of the plane on the stage: `cover` (the default) fills the stage, `contain` shows the whole box; `zoom` and `shift` (metres) frame a part of it. The view turns y down.
- `ringsOnStage` and `linesOnStage` cut the layer to the view with a margin (120 units, room for a camera's push), drop what is too small to see, and thin each outline to at most 200 points without letting it cross itself.
- `toFrame(frame)` projects a `[lon, lat]` the layers do not hold.
- `faultsOf(layers)` lists what is wrong with a city's layers (an outline that runs clockwise, crosses itself or leaves its frame; epochs out of step): a project's test holds each of its cities to an empty list.

The layers hold no colour, no label text and nothing of a frame's design. A name in them (`name`) is data.

## The spec

`examples/cities/valletta.json` is what the command for a new city writes. A spec may ask for more:

| Key | What it asks for |
|---|---|
| `city`, `name`, `centre`, `views` | the id (the file's name), the name, the centre of the city frame `[lon, lat]`, and the named boxes `[west, south, east, north]` |
| `region` | `bbox`, `centre`, `country` (ISO A3), `rivers.names` or `rivers.rank`, `lakes.rank`: the country context, from Natural Earth |
| `water` | `view`, `from` (any of `ohm`, `osm`, `copernicus`), `mask` (the classes of the Copernicus water mask: `ocean`, `lake`, `river`), `cell` (metres), `rivers` (names, or `{ id, name, match }` with a regular expression) |
| `relief` | `view`, `cell`, `smooth` (metres), `contours` (the heights wanted, as a list, or `{ step }` for a line every so many metres), `hills` and `within` |
| `relief.hills[]` | `{ id, name, summit \| spine, floor, reach }`: a hill is the ground that falls away from its `summit` `[lon, lat]`, down to `floor` metres and out to `reach` metres; neighbours part along the hollow between them. A ridge with no one top is given by a `spine`, a line along its crest |
| `relief.within` | `{ wall, margin }`: no hill reaches more than `margin` metres outside that wall. For hills that are spurs of higher ground and have no foot on one side |
| `walls[]` | `{ id, name, built, from: { ohm \| osm: [elements] }, draw?, check?, source }`: the circuit joined from the ways of the elements named; `draw` adds stretches by hand where the map has gaps, and `check` holds the result to another map's fragments |
| `streets` | `view`, `from` (`ohm` or `osm`), `classes`, `minLength`, `year` |
| `builtUp` | `view`, `from` (`ghsl`, `osm` or `natural-earth`), `years` (of `ghsl`), `share` (the share of the ground built on from which a cell counts, 0.2), `bridge` (gaps under twice this many metres are closed, so the city is one body), `round`, `minPiece` |
| `epochs[]` | `{ id, year, name, outline, source, note? }`; the outline is `{ hill }`, `{ wall }`, `{ points: [[lon, lat], ...] }` drawn by hand, `{ builtUp: 2020 }` (the built-up city of that year) or `{ builtUp: true }` (the latest) |
| `landmarks[]` | `{ id, name, built?, at \| ohm \| osm }`: a place given by hand, or the middle of a mapped element |

Every source a layer names in `from` is required: a source that does not answer stops the build, and nothing falls back in silence, so the layers are a function of the spec and the downloads alone.

## Sources and licences

Only open data is read. The table of sources is `lib/sources.mjs`; a source comes into it after its terms are read on its own page.

| Source | For | Licence | In a film's description |
|---|---|---|---|
| Natural Earth 5.1.2, 1:10m | the region | public domain | not required |
| Copernicus DEM GLO-30 and its water body mask | relief; sea, lakes and wide rivers | free with attribution | **required**, the line in `SOURCES.md` |
| Global Human Settlement Layer, GHS-BUILT-S R2023A (European Commission, JRC) | the built-up city of 1975 to today | free and open, reuse with acknowledgment of the source | **required**, the line in `SOURCES.md` |
| OpenHistoricalMap | walls, rivers, streets with their years, landmarks | CC0 | not required |
| OpenStreetMap | water, streets, land use, a wall check | ODbL | **required**: © OpenStreetMap contributors |
| SRTM | relief, where a spec names an HGT file | public domain | not required |

- `<city>/SOURCES.md` is written by the build: the credit lines for the description of a film that shows the layers, the source of every layer, and what was drawn by hand from which written source.
- **Layers made from OpenStreetMap data are a database derived from it**, and the ODbL's share-alike holds for them. This repository holds none: its example reads Natural Earth, Copernicus and the Global Human Settlement Layer only.
- A download is untrusted data. Each lands in a directory of its own under `cache/` and is only ever read as data. `sources.lock.json` holds its SHA-256, and a build whose download differs from the lock stops until it is run with `--update`.
- A request carries a generic client name and nothing of the project that sends it.
- The output is deterministic: the same spec and the same downloads give the same `layers.json`, byte for byte.

## The tests

`test/geom.test.ts` holds the plane geometry and the projection; `test/pipeline.test.mjs` the readers (TIFF, BigTIFF, LZW, ZIP), the grids and contours, the hills, the built-up outline, walls, epochs, the spec of a new city and the options of a project of its own, all on inputs made in the test; `test/example.test.ts` holds the committed example to the format and to what `map.ts` makes of it on a stage. They download nothing.

## Rules

- **General code only.** No name of a production, a channel or a video, and none of its decisions: those live in the project that uses this library. The example and the tests use a neutral city.
- **English only:** code, comments, docs and commit messages.
- **Determinism.** The layers are a pure function of the spec and the downloads. Dependency versions are pinned exactly.
- **Open data only,** each source under its own licence, with its credit written into `SOURCES.md`.
- **Commit explicit paths only.** Before a push, search the diff for production-specific names, personal data, keys and paths of a specific machine.

## Open

- OpenStreetMap's Overpass servers did not answer on the days this was built, so the layers taken from OpenStreetMap (`water`, `streets` and `builtUp` with `from: "osm"`, and a wall's `check`) are written but have not run on a real answer yet. The paths through OpenHistoricalMap, Natural Earth, Copernicus and the Global Human Settlement Layer have.
- Heights are of a surface model: a hill's `height` includes roofs.

## License

Not specified yet for this repository's own code. The data keeps the licences of its sources, listed above and, for a city, in its `SOURCES.md`. Third-party components keep their own licenses: skia-canvas (MIT) and Skia (BSD-3-Clause) draw the previews.
