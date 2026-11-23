import type { NappletManifest } from '../types';
export function decodeJson(source: string): Record<string, unknown>;
export function validateJson(value: unknown): Record<string, unknown>;
export function validateRuntimeManifest(value: unknown): NappletManifest;
export function accessExpansion(previous: Pick<NappletManifest, 'collections' | 'capabilities'>, next: Pick<NappletManifest, 'collections' | 'capabilities'>): string[];
export function canonical(value: unknown): string;
export function parseRuntimeManifest(html: string): NappletManifest;
