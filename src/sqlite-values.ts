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
