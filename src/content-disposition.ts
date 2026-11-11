/** ASCII-safe HTTP header with the original Unicode name carried by RFC 8187 filename*. */
export function inlineContentDisposition(fileName: string): string {
  const name = new TextDecoder().decode(new TextEncoder().encode(fileName || 'file.bin'))
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_');
  const fallback = name.replace(/[^\x20-\x7e]|"/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
