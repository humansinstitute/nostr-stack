import type { FlightDeckPgArtefactType } from '../types';

/** Current stored media type is authoritative, including legacy Files without metadata. */
export function classifyFlightDeckPgArtefact(contentType: string | null | undefined): FlightDeckPgArtefactType | null {
  const mediaType = String(contentType || '').split(';')[0]!.trim().toLowerCase();
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
  if (mediaType === 'application/vnd.excalidraw+json') return 'excalidraw';
  return null;
}
