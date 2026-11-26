// A reader of netCDF classic files (the CDF-1 format and its 64-bit offset form, CDF-2), with Node alone: the
// dimensions, the attributes and the variables of the header, and the values of a variable that is not a record
// variable. Grids of the sea floor (the age of the oceanic crust, the kinds of sediment) come in it.

const TYPES = {
  1: { name: 'byte', size: 1, read: (v, o) => v.getInt8(o) },
  2: { name: 'char', size: 1, read: (v, o) => v.getUint8(o) },
  3: { name: 'short', size: 2, read: (v, o) => v.getInt16(o, false) },
  4: { name: 'int', size: 4, read: (v, o) => v.getInt32(o, false) },
  5: { name: 'float', size: 4, read: (v, o) => v.getFloat32(o, false) },
  6: { name: 'double', size: 8, read: (v, o) => v.getFloat64(o, false) },
};
const NC_DIMENSION = 10;
const NC_VARIABLE = 11;
const NC_ATTRIBUTE = 12;

/**
 * The header of a netCDF classic file, given as its bytes: `{ dims, attrs, vars }`. `dims` are `{ name, size }`;
 * `attrs` an object of the global attributes (a text as a string, numbers as an array); each variable is
 * `{ name, dims, attrs, type, begin, size }`, `dims` its dimensions by name, `begin` the offset of its values in the
 * file. A file of another format (netCDF-4, which is HDF5) is refused with what it is.
 */
export function readNetcdfHeader(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x48 && buf[2] === 0x44 && buf[3] === 0x46) {
    throw new Error('netcdf: the file is netCDF-4 (HDF5); only the classic format is read: take the classic file of the source (".grd" or a netCDF-3 ".nc")');
  }
  if (buf.length < 8 || buf.toString('latin1', 0, 3) !== 'CDF' || (buf[3] !== 1 && buf[3] !== 2)) throw new Error('netcdf: not a netCDF classic file (no "CDF" 1 or 2 at its start)');
  const wide = buf[3] === 2;
  let at = 4;
  const u32 = () => {
    if (at + 4 > buf.length) throw new Error('netcdf: the header ends early');
    const v = view.getUint32(at, false);
    at += 4;
    return v;
  };
  const name = () => {
    const n = u32();
    if (at + n > buf.length) throw new Error('netcdf: the header ends early');
    const s = buf.toString('utf8', at, at + n);
    at += Math.ceil(n / 4) * 4;
    return s;
  };
  const type = () => {
    const t = u32();
    if (!TYPES[t]) throw new Error(`netcdf: unknown type ${t}`);
    return t;
  };
  const list = (tag, item) => {
    const got = u32();
    const n = u32();
    if (got === 0 && n === 0) return [];
    if (got !== tag) throw new Error(`netcdf: the header has ${got} where ${tag} was expected`);
    return Array.from({ length: n }, item);
  };
  const attributes = () => {
    const out = {};
    for (const [k, v] of list(NC_ATTRIBUTE, () => {
      const key = name();
      const t = type();
      const n = u32();
      const { size, read } = TYPES[t];
      if (at + n * size > buf.length) throw new Error('netcdf: the header ends early');
      let value;
      if (t === 2) value = buf.toString('utf8', at, at + n).replace(/\0+$/, '');
      else value = Array.from({ length: n }, (_, i) => read(view, at + i * size));
      at += Math.ceil((n * size) / 4) * 4;
      return [key, value];
    })) out[k] = v;
    return out;
  };
  const records = u32();
  const dims = list(NC_DIMENSION, () => ({ name: name(), size: u32() }));
  const attrs = attributes();
  const vars = list(NC_VARIABLE, () => {
    const key = name();
    const ids = Array.from({ length: u32() }, () => u32());
    const vattrs = attributes();
    const t = type();
    const vsize = u32();
    const begin = wide ? Number(view.getBigUint64((at += 8) - 8, false)) : u32();
    for (const id of ids) if (!dims[id]) throw new Error(`netcdf: the variable ${key} names the dimension ${id}, which the file does not have`);
    return { name: key, dims: ids.map((id) => dims[id].name), shape: ids.map((id) => dims[id].size), attrs: vattrs, type: TYPES[t].name, typeId: t, begin, size: vsize };
  });
  return { records, dims, attrs, vars };
}

/**
 * The values of a variable of a netCDF classic file as a Float64Array, row by row along its dimensions as the file
 * holds them (the last dimension the fastest). `_FillValue` and `missing_value` become NaN, and `scale_factor` and
 * `add_offset` are applied. A record variable (one along the unlimited dimension) is refused.
 */
export function readNetcdfVariable(bytes, varName) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = readNetcdfHeader(buf);
  const v = header.vars.find((x) => x.name === varName);
  if (!v) throw new Error(`netcdf: no variable "${varName}" (the file has ${header.vars.map((x) => x.name).join(', ')})`);
  if (v.shape.some((n) => n === 0)) throw new Error(`netcdf: "${varName}" is a record variable, which is not read`);
  const count = v.shape.reduce((a, b) => a * b, 1);
  const { size, read } = TYPES[v.typeId];
  if (v.begin + count * size > buf.length) throw new Error(`netcdf: the values of "${varName}" run past the end of the file`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fill = [v.attrs._FillValue, v.attrs.missing_value].flatMap((a) => (Array.isArray(a) ? a : []));
  const scale = Array.isArray(v.attrs.scale_factor) ? v.attrs.scale_factor[0] : 1;
  const offset = Array.isArray(v.attrs.add_offset) ? v.attrs.add_offset[0] : 0;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const raw = read(view, v.begin + i * size);
    out[i] = Number.isNaN(raw) || fill.includes(raw) ? Number.NaN : raw * scale + offset;
  }
  return { values: out, shape: v.shape, dims: v.dims, attrs: v.attrs };
}
