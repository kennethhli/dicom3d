const IGNORED = /(^\.|^DICOMDIR$|\.(txt|xml|json|jpg|jpeg|png|pdf|html?|ini|exe|zip)$)/i

function readEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => (entry as FileSystemFileEntry).file((f) => resolve([f]), () => resolve([])))
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    return new Promise((resolve) => {
      const all: Promise<File[]>[] = []
      // readEntries returns results in batches, so keep reading until it comes back empty.
      const next = () =>
        reader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              Promise.all(all).then((lists) => resolve(lists.flat()))
              return
            }
            for (const e of batch) all.push(readEntry(e))
            next()
          },
          () => resolve([]),
        )
      next()
    })
  }
  return Promise.resolve([])
}

/** Collects files from a drop, recursing into dropped folders. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e)
  const files = entries.length ? (await Promise.all(entries.map(readEntry))).flat() : Array.from(dt.files)
  return filterDicomCandidates(files)
}

/** DICOM files frequently have no extension, so filter out known non-DICOM files instead. */
export function filterDicomCandidates(files: File[]): File[] {
  return files.filter((f) => !IGNORED.test(f.name) && f.size > 132)
}
