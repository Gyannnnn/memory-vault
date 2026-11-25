/** A chosen file and its path inside what was chosen ("Trip/Day 1/IMG_1.jpg"). */
export interface Chosen {
  file: File;
  path: string;
}

/** From a file input: folders give each file's path inside the folder. */
export function fromInput(files: FileList | null): Chosen[] {
  return [...(files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    // readEntries returns a batch at a time; an empty batch means done.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(entries);
        else {
          entries.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, into: Chosen[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    into.push({ file, path: entry.fullPath.replace(/^\/+/, '') });
  } else if (entry.isDirectory) {
    for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader()))
      await walk(child, into);
  }
}

/** From a drop: files and whole folders, every file inside them included. */
export async function fromDrop(transfer: DataTransfer): Promise<Chosen[]> {
  const entries = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return fromInput(transfer.files);
  const chosen: Chosen[] = [];
  for (const entry of entries) await walk(entry, chosen);
  return chosen;
}
