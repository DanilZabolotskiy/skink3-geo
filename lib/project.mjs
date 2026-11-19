// The projection of the geo pipeline: from [lon, lat] in degrees to a plane in metres, x east and y
// north of the centre of a frame. One projection serves both scales, the country and the city:
// Lambert's azimuthal equal-area on a sphere, centred on the frame. Round its centre it keeps shapes
// true (the scale error grows with the square of the distance: 0.2 % at 600 km, nothing at a city's
// size), so a country is not stretched at its far end as it is on a plate carrée.

/** The mean radius of the Earth, in metres (IUGG). */
export const EARTH_RADIUS = 6371008.8;

const RAD = Math.PI / 180;

/**
 * The projection centred on [lon, lat]: { lon, lat, forward([lon, lat]) -> [x, y], inverse([x, y]) -> [lon, lat] }.
 * x and y are metres on the sphere, y to the north.
 */
export function projection({ lon, lat }) {
  const l0 = lon * RAD;
  const p0 = lat * RAD;
  const [s0, c0] = [Math.sin(p0), Math.cos(p0)];
  const forward = ([lo, la]) => {
    const dl = lo * RAD - l0;
    const p = la * RAD;
    const [sp, cp] = [Math.sin(p), Math.cos(p)];
    const k = Math.sqrt(2 / (1 + s0 * sp + c0 * cp * Math.cos(dl)));
    return [EARTH_RADIUS * k * cp * Math.sin(dl), EARTH_RADIUS * k * (c0 * sp - s0 * cp * Math.cos(dl))];
  };
  const inverse = ([x, y]) => {
    const rho = Math.hypot(x, y);
    if (rho < 1e-9) return [lon, lat];
    const c = 2 * Math.asin(Math.min(1, rho / (2 * EARTH_RADIUS)));
    const [sc, cc] = [Math.sin(c), Math.cos(c)];
    const p = Math.asin(cc * s0 + (y * sc * c0) / rho);
    const l = l0 + Math.atan2(x * sc, rho * c0 * cc - y * s0 * sc);
    return [l / RAD, p / RAD];
  };
  return { lon, lat, forward, inverse };
}

/** The box [x0, y0, x1, y1] in the plane that holds the lon/lat box [lon0, lat0, lon1, lat1]: its edges are walked, since they curve. */
export function projectBox(proj, [lon0, lat0, lon1, lat1], steps = 32) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const p of [
      [lon0 + (lon1 - lon0) * t, lat0],
      [lon0 + (lon1 - lon0) * t, lat1],
      [lon0, lat0 + (lat1 - lat0) * t],
      [lon1, lat0 + (lat1 - lat0) * t],
    ]) {
      const [x, y] = proj.forward(p);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1, y1];
}

/**
 * The lon/lat box that holds the plane box [x0, y0, x1, y1]: what must be fetched to fill a frame.
 * Its edges are walked for the same reason.
 */
export function unprojectBox(proj, [x0, y0, x1, y1], steps = 32) {
  let [a0, b0, a1, b1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const p of [
      [x0 + (x1 - x0) * t, y0],
      [x0 + (x1 - x0) * t, y1],
      [x0, y0 + (y1 - y0) * t],
      [x1, y0 + (y1 - y0) * t],
    ]) {
      const [lo, la] = proj.inverse(p);
      a0 = Math.min(a0, lo);
      b0 = Math.min(b0, la);
      a1 = Math.max(a1, lo);
      b1 = Math.max(b1, la);
    }
  }
  return [a0, b0, a1, b1];
}
