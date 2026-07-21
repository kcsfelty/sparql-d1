import { describe, expect, it } from 'vitest';
import { readSqliteBytes } from '../src/sqlite-values.js';

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
