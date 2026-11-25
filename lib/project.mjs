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

/**
 * The Equal Earth projection of the whole world (Šavrič, Patterson and Jenny, 2018): { lon, lat: 0, forward, inverse },
 * metres on the sphere, x east of the central meridian `lon` (0 by default) and y north of the equator. Its parallels
 * are straight lines, its meridians curve evenly toward the poles, which are lines a little over half as long as the
 * equator, and areas are true everywhere: the whole world on one flat map, every continent at its true size and in a
 * shape one knows. Round a meridian other than 0, a longitude is taken to the side of the central meridian it lies
 * nearer to, so the map's edge is the meridian opposite it; `inverse` gives longitudes from -180 to 180.
 */
export function equalEarth(lon = 0) {
  if (!(Number.isFinite(lon) && lon >= -180 && lon <= 180)) throw new Error(`equalEarth: the central meridian is a longitude from -180 to 180, got ${lon}`);
  const [A1, A2, A3, A4] = [1.340264, -0.081106, 0.000893, 0.003796];
  const M = Math.sqrt(3) / 2;
  const height = (t, t2, t6) => t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
  const slope = (t2, t6) => A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
  // Round the 0th meridian a longitude is used as it is, as it always was; round another it is taken relative to it.
  const along = lon === 0 ? (lo) => lo : (lo) => {
    const d = lo - lon;
    return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
  };
  const forward = ([lo, la]) => {
    const t = Math.asin(M * Math.sin(la * RAD));
    const [t2, t6] = [t * t, t ** 6];
    return [(EARTH_RADIUS * along(lo) * RAD * Math.cos(t)) / (M * slope(t2, t6)), EARTH_RADIUS * height(t, t2, t6)];
  };
  const inverse = ([x, y]) => {
    const v = y / EARTH_RADIUS;
    let t = v;
    for (let i = 0; i < 20; i++) {
      const [t2, t6] = [t * t, t ** 6];
      const step = (height(t, t2, t6) - v) / slope(t2, t6);
      t -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    const [t2, t6] = [t * t, t ** 6];
    const lo = (M * (x / EARTH_RADIUS) * slope(t2, t6)) / Math.cos(t) / RAD;
    const la = Math.asin(Math.min(1, Math.max(-1, Math.sin(t) / M))) / RAD;
    if (lon === 0) return [lo, la];
    const l = lo + lon;
    return [l > 180 ? l - 360 : l < -180 ? l + 360 : l, la];
  };
  return { lon, lat: 0, forward, inverse };
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
