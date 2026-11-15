/** E-36: full white-label configuration with accessibility-checked colors. Presentation only, never permissions. */
export type BrandConfig = Readonly<{
  name: string; shortName: string; tagline: string; locale: string; supportEmail: string | null;
  colors: Readonly<{ background: string; text: string; primary: string; accent: string }>;
  typography: 'serif' | 'sans' | 'system'; customDomains: readonly string[]; footer: string; features: Readonly<{ audienceQuestions: boolean; publicResults: boolean; transcripts: boolean }>;
}>;
export class BrandError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new BrandError(code); };
const HEX = /^#[0-9a-f]{6}$/;
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
/** WCAG 2.x contrast ratio. */
export function contrast(a: string, b: string): number { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05); }
const str = (v: unknown, code: string, min: number, max: number) => { if (typeof v !== 'string' || v.trim().length < min || v.length > max || /[<>\0]/.test(v)) fail(code); return (v as string).trim(); };
const keys = (v: unknown, expected: readonly string[], code: string) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== [...expected].sort().join()) fail(code);
  return v as Record<string, unknown>;
};
export function parseBrand(input: unknown): BrandConfig {
  const p = keys(input, ['name', 'shortName', 'tagline', 'locale', 'supportEmail', 'colors', 'typography', 'customDomains', 'footer', 'features'], 'invalid_brand');
  const c = keys(p.colors, ['background', 'text', 'primary', 'accent'], 'invalid_colors');
  const colors = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : fail('invalid_color')])) as BrandConfig['colors'];
  if (contrast(colors.text, colors.background) < 4.5) fail('text_contrast_below_wcag_aa');
  if (contrast(colors.primary, colors.background) < 3) fail('primary_contrast_below_wcag_aa_large');
  const locale = str(p.locale, 'invalid_locale', 2, 20);
  try { new Intl.Locale(locale); } catch { fail('invalid_locale'); }
  const supportEmail = p.supportEmail === null ? null : /^[^@\s<>]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i.test(String(p.supportEmail)) ? String(p.supportEmail) : fail('invalid_email');
  if (!Array.isArray(p.customDomains) || p.customDomains.length > 5) fail('invalid_domains');
  const customDomains = (p.customDomains as unknown[]).map((d) => (typeof d === 'string' && /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : fail('invalid_domain')));
  const f = keys(p.features, ['audienceQuestions', 'publicResults', 'transcripts'], 'invalid_features');
  if (Object.values(f).some((v) => typeof v !== 'boolean')) fail('invalid_features');
  if (!['serif', 'sans', 'system'].includes(String(p.typography))) fail('invalid_typography');
  return Object.freeze({ name: str(p.name, 'invalid_name', 1, 80), shortName: str(p.shortName, 'invalid_short_name', 1, 12), tagline: str(p.tagline, 'invalid_tagline', 0, 160), locale, supportEmail,
    colors: Object.freeze(colors), typography: p.typography as BrandConfig['typography'], customDomains: Object.freeze(customDomains), footer: str(p.footer, 'invalid_footer', 0, 300),
    features: Object.freeze({ audienceQuestions: f.audienceQuestions as boolean, publicResults: f.publicResults as boolean, transcripts: f.transcripts as boolean }) });
}
/** CSS custom properties for a brand; values are validated hex colors only. */
export function brandCss(brand: BrandConfig): string {
  const font = brand.typography === 'serif' ? 'Georgia, serif' : brand.typography === 'sans' ? 'Inter, Helvetica, Arial, sans-serif' : 'system-ui, sans-serif';
  return `:root{--brand-bg:${brand.colors.background};--brand-text:${brand.colors.text};--brand-primary:${brand.colors.primary};--brand-accent:${brand.colors.accent};--brand-font:${font}}`;
}
