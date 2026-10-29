// A reproducible zip from Node built-ins: the same files give the same bytes on every run. Entries are sorted by name,
// every one carries the same fixed time and no owner, link or extra fields, so nothing of the machine or the moment
// gets in. Deflated (level 9), or stored where deflating doesn't make it smaller. Files only: no folder entries.
import { deflateRawSync } from 'node:zlib'

/** The time every entry carries: 1 January 2000 00:00, as an MS-DOS date and time. */
const DOS_TIME = 0
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(data) {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A zip of files: [{ name: 'top/dir/file.js', data: Buffer }], names with forward slashes. */
export function zip(files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of sorted) {
    if (!name || name.startsWith('/') || name.includes('\\')) throw new Error(`bad zip entry name: ${name}`)
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const [method, body] = deflated.length < data.length ? [8, deflated] : [0, data]
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // flags: the name is UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // no extra field
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // made by: MS-DOS, 2.0 (so no Unix mode, and never a link)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    // extra and comment lengths, disk number, internal and external attributes: all 0
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  if (sorted.length > 0xffff || offset > 0xffffffff) throw new Error('too big for a zip without Zip64')
  return Buffer.concat([...locals, directory, end])
}
