import { createReadStream } from 'node:fs';

const table = Array.from({length: 256}, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

// ZIP32, uncompressed, streaming file bodies. The caller bounds archive size.
export async function* zip(entries) {
  let offset = 0;
  const directory = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt16LE(name.length, 26);
    yield local; yield name;
    offset += local.length + name.length;
    let crc = 0xffffffff, size = 0;
    const body = entry.path ? createReadStream(entry.path) : [Buffer.from(entry.text)];
    for await (const chunk of body) {
      for (const byte of chunk) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
      size += chunk.length; offset += chunk.length;
      yield chunk;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor; offset += 16;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x808, 8); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(start, 42);
    directory.push(central, name);
  }
  const directoryStart = offset;
  for (const part of directory) { yield part; offset += part.length; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  yield end;
}
