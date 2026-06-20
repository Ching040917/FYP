---
name: Academic Compliance System
colors:
  surface: '#13131b'
  surface-dim: '#13131b'
  surface-bright: '#393841'
  surface-container-lowest: '#0d0d15'
  surface-container-low: '#1b1b23'
  surface-container: '#1f1f27'
  surface-container-high: '#292932'
  surface-container-highest: '#34343d'
  on-surface: '#e4e1ed'
  on-surface-variant: '#c7c4d7'
  inverse-surface: '#e4e1ed'
  inverse-on-surface: '#303038'
  outline: '#908fa0'
  outline-variant: '#464554'
  surface-tint: '#c0c1ff'
  primary: '#c0c1ff'
  on-primary: '#1000a9'
  primary-container: '#8083ff'
  on-primary-container: '#0d0096'
  inverse-primary: '#494bd6'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffb2b7'
  on-tertiary: '#67001b'
  tertiary-container: '#ff516a'
  on-tertiary-container: '#5b0017'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e1e0ff'
  primary-fixed-dim: '#c0c1ff'
  on-primary-fixed: '#07006c'
  on-primary-fixed-variant: '#2f2ebe'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffdadb'
  tertiary-fixed-dim: '#ffb2b7'
  on-tertiary-fixed: '#40000d'
  on-tertiary-fixed-variant: '#92002a'
  background: '#13131b'
  on-background: '#e4e1ed'
  surface-variant: '#34343d'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  container-max: 1440px
  gutter: 20px
---

## Brand & Style

This design system is engineered for the high-stakes environment of academic auditing, where precision, trust, and clarity are paramount. The brand personality is authoritative yet unobtrusive, prioritizing cognitive ease over decorative flair. 

The aesthetic is **Corporate Modern with a technical edge**, utilizing a deep-space palette to reduce eye strain during long-form data analysis. The visual language conveys a sense of rigorous structure and reliability, ensuring that auditors can navigate complex regulatory frameworks with absolute confidence. High information density is balanced by generous whitespace and a strictly logical hierarchy.

## Colors

The palette is optimized for a sophisticated dark-mode experience, utilizing Slate tones to provide a neutral, professional foundation that minimizes glare.

- **Primary (Indigo-500):** Used for primary actions, active states, and brand recognition.
- **Success (Emerald-500):** Indicates compliant status, passed audits, and positive growth.
- **Error (Rose-500):** Flags critical non-compliance, missing data, or system errors.
- **Warning (Amber-500):** Denotes items requiring attention, upcoming deadlines, or soft-compliance risks.
- **Neutral (Slate):** `Slate-900` serves as the global background, while `Slate-800` is reserved for elevated surface layers like cards and modals.

## Typography

This design system utilizes **Inter** for all UI elements to ensure maximum legibility and a systematic appearance. The type scale is tight and functional, favoring smaller base sizes to accommodate dense data tables and complex audit trails.

- **Headlines:** Use Bold or Semi-Bold weights with slight negative letter-spacing for a modern, authoritative feel.
- **Body:** Standardized at 14px for primary content to maximize the amount of visible information without sacrificing readability.
- **Labels:** Small, uppercase labels with increased letter-spacing are used for table headers and metadata categories.
- **Monospace:** For ID strings, reference codes, and technical logs, use a secondary monospace font to distinguish data from prose.

## Layout & Spacing

The layout follows a **structured 12-column fixed grid** on desktop, providing a stable environment for complex dashboards. 

- **Grid:** A 1440px maximum container width ensures content remains focused. 
- **Information Density:** Spacing follows a 4px baseline. Padding within cards and table cells should be kept lean (typically 12px or 16px) to maximize data visibility.
- **Responsive Behavior:** 
  - **Desktop (1024px+):** Full 12-column grid.
  - **Tablet (768px - 1023px):** 6-column grid, sidebar collapses to an icon rail.
  - **Mobile (<768px):** 4-column fluid grid, margins reduced to 16px, vertical stacking for all card-based components.

## Elevation & Depth

In this dark-mode system, depth is achieved through **Tonal Layering** rather than traditional heavy shadows.

- **Level 0 (Background):** `Slate-900` – The base canvas.
- **Level 1 (Surface):** `Slate-800` – Used for cards, navigation bars, and containers.
- **Borders:** All elevated surfaces must feature a 1px solid border in `Slate-700` (or `border_subtle`) to define edges against the dark background.
- **Shadows:** Minimal, high-spread shadows (0% - 10% opacity) are used only on floating elements like modals or dropdowns to provide a subtle "lift" without disrupting the professional aesthetic.

## Shapes

The design system employs **Soft** geometry. This subtle rounding (4px for base elements) humanizes the technical interface while maintaining a rigorous, "engineered" feel. Large containers like cards should use `rounded-lg` (8px) to clearly define content groupings, while buttons and input fields use the base 4px radius.

## Components

- **Elevated Cards:** The core unit of the interface. Use `Slate-800` background with a 1px `Slate-700` border. Headers within cards should have a subtle bottom divider.
- **Sleek Badges:** Used for compliance status. Badges should be small, semi-transparent versions of the functional colors (e.g., Emerald at 10% opacity) with high-contrast text for accessibility.
- **Minimalist Icons:** Use 20px or 24px stroke-based icons with a consistent 1.5px or 2px weight. Icons should be monochrome (Slate-400) unless indicating a specific status.
- **Data Tables:** High-density rows with `Slate-800` alternating backgrounds for zebra-striping. Hover states should use a subtle highlight in `Slate-700`.
- **Primary Buttons:** Solid `Indigo-500` with white or high-contrast text. Secondary buttons should be "ghost" style with a `Slate-700` border.
- **Input Fields:** Dark backgrounds (`Slate-950`) with `Slate-700` borders. Focus states transition the border to `Indigo-500` with a subtle outer glow.