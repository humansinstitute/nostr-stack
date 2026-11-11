import { expect, test } from 'bun:test';
import { inlineContentDisposition } from '../src/content-disposition';

test('Unicode book names produce valid response headers and retain their UTF-8 filename', async () => {
  const name = 'Jane Austen - Pride and Prejudice (Chapters I–VI).epub';
  // Bun rejects this name when inserted directly into a filename="…" header.
  const response = new Response(new Uint8Array([80, 75, 3, 4]), {
    headers: { 'Content-Disposition': inlineContentDisposition(name) },
  });
  const value = response.headers.get('Content-Disposition')!;
  expect(value).toContain('filename="Jane Austen - Pride and Prejudice (Chapters I_VI).epub"');
  expect(decodeURIComponent(value.split("filename*=UTF-8''")[1])).toBe(name);
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([80, 75, 3, 4]);
});

test('quotes, controls, paths and malformed Unicode cannot break a download response', () => {
  for (const name of ['a";x=y.epub', '../folder\\book\r\nX-Injected: yes.epub', '日本語 📚.epub', '\ud800.epub', '']) {
    const header = inlineContentDisposition(name);
    const response = new Response('book', { headers: { 'Content-Disposition': header } });
    expect(response.headers.has('X-Injected')).toBe(false);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header).toMatch(/^inline; filename="[^"\\]*"; filename\*=UTF-8''/);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).not.toMatch(/[\r\n/\\]/);
  }
});
