// @effect-diagnostics nodeBuiltinImport:off - zlib's crc32 has no Effect equivalent.
/**
 * A streaming ZIP writer: stored (uncompressed) entries, UTF-8 names, data descriptors and ZIP64
 * where a size or offset needs it. Memory grows with the number of entries, never their size.
 */
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const VERSION_ZIP64 = 45;
const VERSION_DEFAULT = 20;
const MADE_BY_UNIX = (3 << 8) | VERSION_ZIP64;

export interface ZipFileBody<R> {
  /** Upper bound of the body's bytes; ZIP64 is chosen from it before the body is read. */
  readonly size: number;
  readonly body: Stream.Stream<Uint8Array, never, R>;
}

export type ZipEntry<R> =
  | { readonly kind: "directory"; readonly name: string; readonly modifiedAt: Date | undefined }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly modifiedAt: Date | undefined;
      /** Opened when the entry is written, in a scope that lasts until its body ends; null skips it. */
      readonly open: Effect.Effect<ZipFileBody<R> | null, never, R | Scope.Scope>;
    };

/** DOS time of `date`; none: the format's earliest, 1980-01-01. */
const dosDateTime = (date: Date | undefined) => {
  if (date === undefined) return { time: 0, date: (1 << 5) | 1 };
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

const encoder = new TextEncoder();

const localHeader = (input: {
  readonly name: Uint8Array;
  readonly modifiedAt: Date | undefined;
  readonly flags: number;
  readonly zip64: boolean;
}) => {
  const extraLength = input.zip64 ? 20 : 0;
  const bytes = new Uint8Array(30 + input.name.byteLength + extraLength);
  const view = new DataView(bytes.buffer);
  const { time, date } = dosDateTime(input.modifiedAt);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, input.zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  view.setUint16(6, input.flags, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, input.zip64 ? MAX_32 : 0, true);
  view.setUint32(22, input.zip64 ? MAX_32 : 0, true);
  view.setUint16(26, input.name.byteLength, true);
  view.setUint16(28, extraLength, true);
  bytes.set(input.name, 30);
  if (input.zip64) {
    const at = 30 + input.name.byteLength;
    view.setUint16(at, 0x0001, true);
    view.setUint16(at + 2, 16, true);
  }
  return bytes;
};

const dataDescriptor = (crc: number, size: number, zip64: boolean) => {
  const bytes = new Uint8Array(zip64 ? 24 : 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc, true);
  if (zip64) {
    view.setBigUint64(8, BigInt(size), true);
    view.setBigUint64(16, BigInt(size), true);
  } else {
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  }
  return bytes;
};

const centralRecord = (input: {
  readonly name: Uint8Array;
  readonly modifiedAt: Date | undefined;
  readonly flags: number;
  readonly versionNeeded: number;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
  readonly directory: boolean;
}) => {
  const zip64 = input.size >= MAX_32 || input.offset >= MAX_32;
  const extraLength = zip64 ? 28 : 0;
  const bytes = new Uint8Array(46 + input.name.byteLength + extraLength);
  const view = new DataView(bytes.buffer);
  const { time, date } = dosDateTime(input.modifiedAt);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, MADE_BY_UNIX, true);
  view.setUint16(6, zip64 ? VERSION_ZIP64 : input.versionNeeded, true);
  view.setUint16(8, input.flags, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, date, true);
  view.setUint32(16, input.crc, true);
  view.setUint32(20, zip64 ? MAX_32 : input.size, true);
  view.setUint32(24, zip64 ? MAX_32 : input.size, true);
  view.setUint16(28, input.name.byteLength, true);
  view.setUint16(30, extraLength, true);
  view.setUint32(
    38,
    (input.directory ? 0o40755 : 0o100644) * 0x10000 + (input.directory ? 0x10 : 0),
    true,
  );
  view.setUint32(42, zip64 ? MAX_32 : input.offset, true);
  bytes.set(input.name, 46);
  if (zip64) {
    const at = 46 + input.name.byteLength;
    view.setUint16(at, 0x0001, true);
    view.setUint16(at + 2, 24, true);
    view.setBigUint64(at + 4, BigInt(input.size), true);
    view.setBigUint64(at + 12, BigInt(input.size), true);
    view.setBigUint64(at + 20, BigInt(input.offset), true);
  }
  return bytes;
};

const endOfCentralDirectory = (count: number, size: number, offset: number) => {
  const zip64 = count >= MAX_16 || size >= MAX_32 || offset >= MAX_32;
  const bytes = new Uint8Array((zip64 ? 56 + 20 : 0) + 22);
  const view = new DataView(bytes.buffer);
  let at = 0;
  if (zip64) {
    view.setUint32(0, 0x06064b50, true);
    view.setBigUint64(4, 44n, true);
    view.setUint16(12, MADE_BY_UNIX, true);
    view.setUint16(14, VERSION_ZIP64, true);
    view.setBigUint64(24, BigInt(count), true);
    view.setBigUint64(32, BigInt(count), true);
    view.setBigUint64(40, BigInt(size), true);
    view.setBigUint64(48, BigInt(offset), true);
    view.setUint32(56, 0x07064b50, true);
    view.setBigUint64(64, BigInt(offset + size), true);
    view.setUint32(72, 1, true);
    at = 76;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, Math.min(count, MAX_16), true);
  view.setUint16(at + 10, Math.min(count, MAX_16), true);
  view.setUint32(at + 12, Math.min(size, MAX_32), true);
  view.setUint32(at + 16, Math.min(offset, MAX_32), true);
  return bytes;
};

export const zipStream = <R>(
  entries: Stream.Stream<ZipEntry<R>, never, R>,
): Stream.Stream<Uint8Array, never, R> =>
  Stream.suspend(() => {
    let offset = 0;
    const central: Array<Uint8Array> = [];
    const emit = (bytes: Uint8Array) => {
      offset += bytes.byteLength;
      return bytes;
    };

    const directoryEntry = (entry: Extract<ZipEntry<R>, { kind: "directory" }>) =>
      Stream.suspend(() => {
        const name = encoder.encode(entry.name.endsWith("/") ? entry.name : `${entry.name}/`);
        central.push(
          centralRecord({
            name,
            modifiedAt: entry.modifiedAt,
            flags: UTF8_FLAG,
            versionNeeded: VERSION_DEFAULT,
            crc: 0,
            size: 0,
            offset,
            directory: true,
          }),
        );
        return Stream.succeed(
          emit(localHeader({ name, modifiedAt: entry.modifiedAt, flags: UTF8_FLAG, zip64: false })),
        );
      });

    const fileEntry = (entry: Extract<ZipEntry<R>, { kind: "file" }>) =>
      Stream.unwrap(
        Effect.map(entry.open, (opened) => {
          if (opened === null) return Stream.empty;
          const name = encoder.encode(entry.name);
          const zip64 = opened.size >= MAX_32;
          const flags = UTF8_FLAG | DATA_DESCRIPTOR_FLAG;
          let crc = 0;
          let size = 0;
          let headerOffset = 0;
          const header = Stream.suspend(() => {
            headerOffset = offset;
            return Stream.succeed(
              emit(localHeader({ name, modifiedAt: entry.modifiedAt, flags, zip64 })),
            );
          });
          const body = opened.body.pipe(
            Stream.map((chunk) => {
              crc = NodeZlib.crc32(chunk, crc);
              size += chunk.byteLength;
              if (!zip64 && size >= MAX_32) {
                throw new Error("A ZIP entry grew past the size it was opened with.");
              }
              return emit(chunk);
            }),
          );
          const trailer = Stream.suspend(() => {
            central.push(
              centralRecord({
                name,
                modifiedAt: entry.modifiedAt,
                flags,
                versionNeeded: zip64 ? VERSION_ZIP64 : VERSION_DEFAULT,
                crc,
                size,
                offset: headerOffset,
                directory: false,
              }),
            );
            return Stream.succeed(emit(dataDescriptor(crc, size, zip64)));
          });
          return header.pipe(Stream.concat(body), Stream.concat(trailer));
        }),
      );

    const body = entries.pipe(
      Stream.flatMap((entry) =>
        entry.kind === "directory" ? directoryEntry(entry) : fileEntry(entry),
      ),
    );
    const end = Stream.suspend(() => {
      const directoryOffset = offset;
      const directorySize = central.reduce((total, record) => total + record.byteLength, 0);
      return Stream.fromIterable([
        ...central,
        endOfCentralDirectory(central.length, directorySize, directoryOffset),
      ]);
    });
    return body.pipe(Stream.concat(end));
  });
