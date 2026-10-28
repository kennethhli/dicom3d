/** Decoder for the API's length-prefixed bundle (see backend/app/bundle.py). */
const MAGIC = [0x44, 0x33, 0x44, 0x42] // "D3DB"

export function decodeBundle(payload: ArrayBuffer): ArrayBuffer[] {
  const view = new DataView(payload)
  for (let i = 0; i < 4; i++) {
    if (view.getUint8(i) !== MAGIC[i]) throw new Error('Response is not a DICOM3D bundle')
  }
  const version = view.getUint32(4, true)
  if (version !== 1) throw new Error(`Unsupported bundle version ${version}`)
  const count = view.getUint32(8, true)
  const files: ArrayBuffer[] = []
  let offset = 12
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(offset, true)
    offset += 4
    if (offset + length > payload.byteLength) throw new Error('Bundle is truncated')
    files.push(payload.slice(offset, offset + length))
    offset += length
  }
  return files
}
