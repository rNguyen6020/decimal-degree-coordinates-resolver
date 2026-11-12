# decimal-degree-coordinates-resolver

Converts sexagesimal degree-minute-second coordinate strings into decimal-degree floats, returning `{latitude, longitude}` for geospatial time mapping.

```js
import { parseCoordinate } from 'decimal-degree-coordinates-resolver';

const { latitude, longitude } = parseCoordinate('48 51 24 N, 2 21 8 E');
// latitude  ≈ 48.856667
// longitude ≈ 2.352222
```

## Why

Geospatial time-mapping pipelines consume coordinates from heterogeneous sources: surveyor notes in full DMS, CSV exports in decimal degrees, and pasted strings that mix the two. This library is the single normalisation step that accepts any of those per-component forms — `D`, `D.d`, `D M`, `D M.m`, `D M S`, `D M S.s`, with optional leading sign and optional trailing cardinal letter — and yields plain floats ready to feed into a time-indexed spatial index.

The trade-off: the parser is strictly positional per component. It does **not** accept packed "DDMMSS" strings like `481230N`, because those carry an implicit field-width spec that varies by source and silently mis-splits when the degree field has fewer than two digits. If your data is in that form, expand it upstream before calling this.

## Edge you will hit

Latitude is always first, longitude second — GeoJSON / RFC 7946 axis order. Some older CSV exports put longitude first. Mixing the two is how coordinates end up in the ocean, so this library picks one order and enforces it rather than guessing.

A leading minus that contradicts a trailing cardinal (`-48 N`) throws a `ParseError` rather than picking a winner. Out-of-range values throw instead of clamping, because clamping a mistyped coordinate by 90° relocates it silently.

`ParseError` is exported and subclasses `Error`; catch it at the row level to skip unparseable rows in a batch.

## Exports

- `parseCoordinate(input: string | [string, string]) → { latitude: number, longitude: number }`
- `ParseError` (subclass of `Error`)

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

