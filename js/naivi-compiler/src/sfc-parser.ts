// SFC Parser — wraps @vue/compiler-sfc to extract template, script, and styles.

import { parse, type SFCDescriptor } from '@vue/compiler-sfc';

export interface ParsedSFC {
  descriptor: SFCDescriptor;
  source: string;
}

/** Parse a .vue SFC source string. Throws if no <template> found. */
export function parseSFC(source: string): ParsedSFC {
  const { descriptor, errors } = parse(source);
  if (errors.length > 0) {
    throw new Error(`SFC parse error: ${errors.map(e => e.message).join('; ')}`);
  }
  if (!descriptor.template) {
    throw new Error('No <template> found in .vue file');
  }
  return { descriptor, source };
}

/** Extract raw template content from the SFC descriptor. */
export function getTemplateContent(descriptor: SFCDescriptor): string {
  return descriptor.template?.content ?? '';
}

/** Extract <script setup> content from the SFC descriptor. */
export function getScriptContent(descriptor: SFCDescriptor): string {
  if (descriptor.scriptSetup) {
    return descriptor.scriptSetup.content;
  }
  if (descriptor.script) {
    return descriptor.script.content;
  }
  return '';
}
