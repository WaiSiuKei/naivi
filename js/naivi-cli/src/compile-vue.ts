// compile-vue.ts — build-time style compilation (Tailwind → Style IR only).
// Self-contained: no dependency on @naive/compiler to avoid workspace link issues.
//
// Rendering is always done at runtime via Vue Vapor → native-tree → Core.

export interface CompileResult {
  styles: string; // JSON style table for runtime
}

/** Compile Tailwind classes from source to a Style IR JSON string. */
export function compileVue(source: string): CompileResult {
  // Extract class strings
  const classMatch = source.match(/class="([^"]*)"/g) ?? [];
  const classStrings: string[] = [];
  for (const m of classMatch) {
    const classes = m.match(/class="([^"]*)"/)?.[1];
    if (classes) classStrings.push(classes);
  }

  // Simple style compilation: split Tailwind classes into key-value pairs
  const styleMap: Record<string, Record<string, string | number>> = {};
  let id = 0;
  for (const classStr of classStrings) {
    const classes = classStr.split(/\s+/).filter(Boolean);
    const props: Record<string, string | number> = {};
    for (const cls of classes) {
      compileClass(cls, props);
    }
    if (Object.keys(props).length > 0) {
      styleMap[String(id)] = props;
      id++;
    }
  }
  return { styles: JSON.stringify(styleMap) };
}

// Minimal Tailwind class → Style mapping (subset for demo).
function compileClass(cls: string, props: Record<string, string | number>): void {
  if (cls === 'flex') { props.display = 'flex'; return; }
  if (cls === 'flex-col') { props.flex_direction = 'column'; return; }
  if (cls === 'flex-row') { props.flex_direction = 'row'; return; }
  if (cls === 'items-center') { props.align_items = 'center'; return; }
  if (cls === 'justify-center') { props.justify_content = 'center'; return; }
  const gapM = cls.match(/^gap-(\d+)$/);
  if (gapM) { props.gap = parseInt(gapM[1]) * 4; return; }
  const pM = cls.match(/^p-(\d+)$/);
  if (pM) { const v = parseInt(pM[1]) * 4; props.padding = v; return; }
  const pxM = cls.match(/^px-(\d+)$/);
  if (pxM) { props.padding_left = parseInt(pxM[1]) * 4; props.padding_right = parseInt(pxM[1]) * 4; return; }
  const pyM = cls.match(/^py-(\d+)$/);
  if (pyM) { props.padding_top = parseInt(pyM[1]) * 4; props.padding_bottom = parseInt(pyM[1]) * 4; return; }
  if (cls === 'rounded-lg') { props.border_radius = 8; return; }
  if (cls === 'rounded-md') { props.border_radius = 6; return; }
  // Colors
  if (cls === 'bg-slate-50') { props.background_color = '#f8fafc'; return; }
  if (cls === 'bg-slate-900') { props.background_color = '#0f172a'; return; }
  if (cls === 'bg-blue-600') { props.background_color = '#2563eb'; return; }
  if (cls === 'bg-blue-500') { props.background_color = '#3b82f6'; return; }
  if (cls === 'text-white') { props.text_color = '#ffffff'; return; }
  if (cls === 'text-slate-950') { props.text_color = '#020617'; return; }
  // Text
  if (cls === 'text-xl') { props.font_size = 20; return; }
  if (cls === 'text-2xl') { props.font_size = 24; return; }
  if (cls === 'text-lg') { props.font_size = 18; return; }
  if (cls === 'font-bold') { props.font_weight = 'bold'; return; }
  if (cls === 'font-semibold') { props.font_weight = 'bold'; return; }
  // Transitions
  if (cls === 'transition-all') { props.transition = 'all'; return; }
  if (cls === 'transition-colors') { props.transition = 'colors'; return; }
  if (cls === 'duration-150') { props.transition_duration = 150; return; }
  // Hover/active variants
  if (cls === 'hover:bg-blue-500') { props.hover_background_color = '#3b82f6'; return; }
  if (cls === 'active:scale-95') { props.active_scale = 0.95; return; }
  if (cls === 'focus:bg-blue-500') { props.focus_background_color = '#3b82f6'; return; }
}
