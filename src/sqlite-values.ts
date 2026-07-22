/** Conservative portable headroom below D1's 2 MB bound-value limit. */
export const MAX_PORTABLE_SQLITE_BIND_BYTES = 1_900_000;

export type SqlitePayload = string | ArrayBuffer | ArrayBufferView;

/** Return the exact UTF-8 or binary byte length used for a SQLite binding. */
export function sqlitePayloadByteLength(value: SqlitePayload): number {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.byteLength;
}

/**
 * Fail before database work when caller-owned text/BLOB values exceed an
 * explicit aggregate bound. The default is the portable D1-safe headroom.
 */
export function assertSqlitePayloadSize(
  values: Iterable<SqlitePayload>,
  maxBytes = MAX_PORTABLE_SQLITE_BIND_BYTES,
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      'SQLite payload maxBytes must be a non-negative safe integer',
    );
  }
  let bytes = 0;
  for (const value of values) {
    bytes += sqlitePayloadByteLength(value);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      throw new RangeError(
        `SQLite payload exceeds the configured ${maxBytes}-byte limit`,
      );
    }
  }
  return bytes;
}

/**
 * Return a detached byte view for a SQLite BLOB returned by a supported
 * Diamond adapter.
 *
 * Node's built-in SQLite driver returns a Uint8Array while workerd D1 returns
 * a JSON-compatible byte array. Keeping the conversion explicit prevents
 * database-specific row shapes from leaking into portable application code.
 */
export function readSqliteBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (
        !Object.hasOwn(value, index) ||
        !Number.isInteger(value[index]) ||
        value[index] < 0 ||
        value[index] > 255
      ) {
        throw new TypeError(
          'SQLite BLOB byte arrays must be dense and contain only integers from 0 through 255',
        );
      }
    }
    return Uint8Array.from(value as number[]);
  }
  throw new TypeError(
    'SQLite BLOB value must be an ArrayBuffer, an ArrayBuffer view, or a byte array',
  );
}
