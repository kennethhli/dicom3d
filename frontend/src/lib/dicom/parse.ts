import * as dicomParser from 'dicom-parser'
import type { ParsedSlice, Vec3 } from '@/lib/types'

const TAG = {
  transferSyntax: 'x00020010',
  modality: 'x00080060',
  seriesDescription: 'x0008103e',
  seriesUid: 'x0020000e',
  instanceNumber: 'x00200013',
  imagePosition: 'x00200032',
  imageOrientation: 'x00200037',
  sliceLocation: 'x00201041',
  sliceThickness: 'x00180050',
  samplesPerPixel: 'x00280002',
  photometric: 'x00280004',
  numberOfFrames: 'x00280008',
  rows: 'x00280010',
  columns: 'x00280011',
  pixelSpacing: 'x00280030',
  bitsAllocated: 'x00280100',
  bitsStored: 'x00280101',
  pixelRepresentation: 'x00280103',
  windowCenter: 'x00281050',
  windowWidth: 'x00281051',
  rescaleIntercept: 'x00281052',
  rescaleSlope: 'x00281053',
  pixelData: 'x7fe00010',
} as const

const UNCOMPRESSED_SYNTAXES = new Set([
  '1.2.840.10008.1.2', // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
  '1.2.840.10008.1.2.1.99', // Deflated Explicit VR Little Endian (inflated by the parser)
  '1.2.840.10008.1.2.2', // Explicit VR Big Endian (retired)
])

export class DicomParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DicomParseError'
  }
}

function numbers(ds: dicomParser.DataSet, tag: string, count: number): number[] | null {
  const n = ds.numStringValues(tag)
  if (!n || n < count) return null
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const v = ds.floatString(tag, i)
    if (v === undefined || !Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

function finite(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) ? v : null
}

/**
 * Decode stored pixel values from raw bytes. Copies into an aligned buffer since
 * the pixel data offset inside a Part 10 file is not guaranteed to be even.
 */
function readStoredPixels(
  bytes: Uint8Array,
  offset: number,
  count: number,
  bitsAllocated: number,
  bitsStored: number,
  signed: boolean,
  bigEndian: boolean,
): ArrayLike<number> {
  const bytesPer = bitsAllocated / 8
  const needed = count * bytesPer
  if (offset + needed > bytes.byteLength) {
    throw new DicomParseError('Pixel data is shorter than Rows × Columns')
  }
  const copy = bytes.slice(offset, offset + needed)
  if (bitsAllocated === 8) return signed ? new Int8Array(copy.buffer) : copy

  if (bigEndian) {
    for (let i = 0; i < copy.length; i += bytesPer) copy.subarray(i, i + bytesPer).reverse()
  }

  if (bitsAllocated === 16) {
    const raw = signed ? new Int16Array(copy.buffer) : new Uint16Array(copy.buffer)
    // Mask off overlay bits that some scanners pack above BitsStored.
    if (bitsStored < 16) {
      const mask = (1 << bitsStored) - 1
      const signBit = 1 << (bitsStored - 1)
      const out = new Int32Array(count)
      for (let i = 0; i < count; i++) {
        let v = raw[i] & mask
        if (signed && v & signBit) v -= 1 << bitsStored
        out[i] = v
      }
      return out
    }
    return raw
  }
  if (bitsAllocated === 32) return signed ? new Int32Array(copy.buffer) : new Uint32Array(copy.buffer)
  throw new DicomParseError(`Unsupported BitsAllocated=${bitsAllocated}`)
}

/**
 * Parse one DICOM Part 10 buffer and convert stored values to modality units:
 * HU = stored × RescaleSlope + RescaleIntercept.
 */
export function parseSlice(buffer: ArrayBuffer, index: number): ParsedSlice {
  const bytes = new Uint8Array(buffer)
  let ds: dicomParser.DataSet
  try {
    ds = dicomParser.parseDicom(bytes)
  } catch (err) {
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : 'unknown error'
    throw new DicomParseError(`Not a readable DICOM file (${msg})`)
  }

  const transferSyntax = ds.string(TAG.transferSyntax) ?? '1.2.840.10008.1.2'
  const pixelEl = ds.elements[TAG.pixelData]
  if (!pixelEl) throw new DicomParseError('File has no PixelData element')
  if (pixelEl.encapsulatedPixelData || !UNCOMPRESSED_SYNTAXES.has(transferSyntax)) {
    throw new DicomParseError(`Compressed transfer syntax ${transferSyntax} is not supported`)
  }

  const rows = ds.uint16(TAG.rows)
  const cols = ds.uint16(TAG.columns)
  if (!rows || !cols) throw new DicomParseError('Missing Rows/Columns')
  const samples = ds.uint16(TAG.samplesPerPixel) ?? 1
  if (samples !== 1) throw new DicomParseError('Only single-channel (grayscale) images are supported')
  const frames = ds.intString(TAG.numberOfFrames) ?? 1
  if (frames > 1) throw new DicomParseError('Multi-frame images are not supported yet')

  const bitsAllocated = ds.uint16(TAG.bitsAllocated) ?? 16
  const bitsStored = ds.uint16(TAG.bitsStored) ?? bitsAllocated
  const signed = (ds.uint16(TAG.pixelRepresentation) ?? 0) === 1
  const slope = finite(ds.floatString(TAG.rescaleSlope)) ?? 1
  const intercept = finite(ds.floatString(TAG.rescaleIntercept)) ?? 0
  const photometric = (ds.string(TAG.photometric) ?? 'MONOCHROME2').trim()
  const count = rows * cols

  const stored = readStoredPixels(
    bytes,
    pixelEl.dataOffset,
    count,
    bitsAllocated,
    bitsStored,
    signed,
    transferSyntax === '1.2.840.10008.1.2.2',
  )

  const values = new Float32Array(count)
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < count; i++) {
    const v = stored[i] * slope + intercept
    values[i] = v
    if (v < min) min = v
    if (v > max) max = v
  }
  if (photometric === 'MONOCHROME1') {
    for (let i = 0; i < count; i++) values[i] = max + min - values[i]
  }

  const position = numbers(ds, TAG.imagePosition, 3) as Vec3 | null
  const orientation = numbers(ds, TAG.imageOrientation, 6) as ParsedSlice['orientation']
  const spacing = numbers(ds, TAG.pixelSpacing, 2)

  return {
    index,
    rows,
    cols,
    values,
    min,
    max,
    position,
    orientation,
    // PixelSpacing is (row spacing, column spacing); store as (x, y).
    pixelSpacing: spacing ? [spacing[1], spacing[0]] : [1, 1],
    sliceThickness: finite(ds.floatString(TAG.sliceThickness)),
    sliceLocation: finite(ds.floatString(TAG.sliceLocation)),
    instanceNumber: finite(ds.intString(TAG.instanceNumber)),
    seriesUid: ds.string(TAG.seriesUid) ?? null,
    modality: (ds.string(TAG.modality) ?? 'OT').trim(),
    windowCenter: finite(ds.floatString(TAG.windowCenter)),
    windowWidth: finite(ds.floatString(TAG.windowWidth)),
    rescaleSlope: slope,
    rescaleIntercept: intercept,
    photometric,
    seriesDescription: ds.string(TAG.seriesDescription)?.trim() ?? null,
  }
}
