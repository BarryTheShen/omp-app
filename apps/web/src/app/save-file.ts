/**
 * Saves `text` as a file through the browser's download. The object address is revoked right
 * after the click, so nothing stays in memory.
 */
export function saveTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // The download has started by now: the browser keeps its own copy of the bytes.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
