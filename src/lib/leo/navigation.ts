export type ConsoleSectionId = 'realtime' | 'archive' | 'validation';
export type ConsoleSectionDomain = 'l1' | 'leo';

export type ConsoleSectionDomains = Record<ConsoleSectionId, ConsoleSectionDomain>;

export const DEFAULT_CONSOLE_SECTION_DOMAINS: Readonly<ConsoleSectionDomains> = Object.freeze({
  realtime: 'l1',
  archive: 'l1',
  validation: 'l1',
});

export function createDefaultConsoleSectionDomains(): ConsoleSectionDomains {
  return { ...DEFAULT_CONSOLE_SECTION_DOMAINS };
}

export function normalizeConsoleSectionDomain(value: unknown): ConsoleSectionDomain {
  return value === 'leo' ? 'leo' : 'l1';
}

