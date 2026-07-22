import { describe, expect, it } from 'vitest';
import {
  MAX_PORTABLE_SQLITE_BIND_BYTES,
  assertSqlitePayloadSize,
  readSqliteBytes,
  sqlitePayloadByteLength,
} from '../src/sqlite-values.js';

describe('readSqliteBytes', () => {
  it('normalizes every supported binary row representation to a copy', () => {
    const typed = Uint8Array.from([1, 2, 3]);
    const fromTyped = readSqliteBytes(typed);
    typed.fill(9);
    expect([...fromTyped]).toEqual([1, 2, 3]);

    const buffer = Uint8Array.from([4, 5]).buffer;
    expect([...readSqliteBytes(buffer)]).toEqual([4, 5]);

    const dataView = new DataView(Uint8Array.from([6, 7]).buffer);
    expect([...readSqliteBytes(dataView)]).toEqual([6, 7]);

    const array = [8, 255];
    const fromArray = readSqliteBytes(array);
    array[0] = 0;
    expect([...fromArray]).toEqual([8, 255]);
  });

  it('rejects non-binary and invalid byte-array values', () => {
    const sparse = new Array<number>(2);
    sparse[1] = 1;
    for (const value of [null, 'bytes', [1, -1], [1, 256], [1, 1.5], sparse]) {
      expect(() => readSqliteBytes(value)).toThrow(TypeError);
    }
  });
});

describe('portable SQLite payload bounds', () => {
  it('measures UTF-8 text and binary views without coercion', () => {
    expect(sqlitePayloadByteLength('hé')).toBe(3);
    expect(sqlitePayloadByteLength(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(assertSqlitePayloadSize(['hé', new Uint8Array([1, 2, 3])], 6)).toBe(
      6,
    );
  });

  it('enforces the portable default and caller-selected bounds', () => {
    expect(MAX_PORTABLE_SQLITE_BIND_BYTES).toBe(1_900_000);
    expect(() => assertSqlitePayloadSize(['1234'], 3)).toThrow(
      /configured 3-byte limit/u,
    );
    expect(() => assertSqlitePayloadSize([], -1)).toThrow(/maxBytes/u);
  });
});
