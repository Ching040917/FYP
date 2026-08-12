/** @type {import('tailwindcss').Config} */
import tailwindcssAnimate from 'tailwindcss-animate'

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ═══════════════════════════════════════════════════════════════
        // Semantic tokens — Manuscript Review Desk palette (Build 2).
        // Single source of truth; legacy M3 names below are aliases.
        // ═══════════════════════════════════════════════════════════════
        background: '#F7F7F4',          // paper
        foreground: '#1F2328',          // ink
        card: '#FFFFFF',                // surface
        'card-foreground': '#1F2328',
        popover: '#FFFFFF',
        'popover-foreground': '#1F2328',
        primary: '#1E3A5F',             // primary action
        'primary-foreground': '#FFFFFF',
        secondary: '#1F7A4D',           // pass
        'secondary-foreground': '#FFFFFF',
        muted: '#E8ECF4',               // selected
        'muted-foreground': '#5F666E',  // ink muted
        accent: '#E8ECF4',              // selected
        'accent-foreground': '#1F2328',
        destructive: '#B3261E',         // fail
        'destructive-foreground': '#FFFFFF',
        border: '#D9DCE1',              // rule
        input: '#D9DCE1',
        ring: '#1E3A5F',                // focus ring
        success: '#1F7A4D',             // pass
        warning: '#8A5A00',
        information: '#2563EB',
        'ai-assisted': '#4A4458',
        selected: '#E8ECF4',
        'chart-1': '#1E3A5F',
        'chart-2': '#1F7A4D',
        'chart-3': '#2563EB',
        'chart-4': '#8A5A00',
        'chart-5': '#4A4458',
        sidebar: '#F7F7F4',
        'sidebar-foreground': '#1F2328',
        'sidebar-primary': '#1E3A5F',
        'sidebar-primary-foreground': '#FFFFFF',
        'sidebar-accent': '#E8ECF4',
        'sidebar-accent-foreground': '#1F2328',
        'sidebar-border': '#D9DCE1',
        'sidebar-ring': '#1E3A5F',

        // ───────── Legacy M3 aliases (light mapping) — pages still use these;
        //            keep until their Build removes them. ─────────
        surface: '#FFFFFF',
        'surface-dim': '#F7F7F4',
        'surface-bright': '#FFFFFF',
        'surface-container-lowest': '#F7F7F4',
        'surface-container-low': '#F7F7F4',
        'surface-container': '#FFFFFF',
        'surface-container-high': '#E8ECF4',
        'surface-container-highest': '#E8ECF4',
        'surface-variant': '#E8ECF4',
        'on-surface': '#1F2328',
        'on-surface-variant': '#3D434A',
        'on-background': '#1F2328',
        outline: '#D9DCE1',
        'outline-variant': '#D9DCE1',
        'surface-tint': '#1E3A5F',
        'inverse-surface': '#1F2328',
        'inverse-on-surface': '#FFFFFF',
        'inverse-primary': '#1E3A5F',
        'on-primary': '#FFFFFF',
        'primary-container': '#2A4E7E',
        'on-primary-container': '#FFFFFF',
        'primary-fixed': '#E8ECF4',
        'primary-fixed-dim': '#D7E0F0',
        'on-primary-fixed': '#1E3A5F',
        'on-primary-fixed-variant': '#2A4E7E',
        'on-secondary': '#FFFFFF',
        'secondary-container': '#E7F4EC',
        'on-secondary-container': '#123B27',
        'secondary-fixed': '#E7F4EC',
        'secondary-fixed-dim': '#BFE3CF',
        'on-secondary-fixed': '#123B27',
        'on-secondary-fixed-variant': '#1F7A4D',
        tertiary: '#2563EB',
        'on-tertiary': '#FFFFFF',
        'tertiary-container': '#E3EDFF',
        'on-tertiary-container': '#123C7E',
        'tertiary-fixed': '#E3EDFF',
        'tertiary-fixed-dim': '#BFD6FF',
        'on-tertiary-fixed': '#123C7E',
        'on-tertiary-fixed-variant': '#2563EB',
        error: '#B3261E',
        'on-error': '#FFFFFF',
        'error-container': '#FBEAE9',
        'on-error-container': '#6B1714',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif'],
        serif: ['Georgia', 'Cambria', 'Times New Roman', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      fontSize: {
        // Approved Build 2 scale
        'page-title': ['28px', { lineHeight: '34px', fontWeight: '600' }],
        'section-title': ['20px', { lineHeight: '26px', fontWeight: '600' }],
        'component-title': ['16px', { lineHeight: '22px', fontWeight: '600' }],
        body: ['14px', { lineHeight: '21px', fontWeight: '400' }],
        label: ['11px', { lineHeight: '16px', fontWeight: '500' }],
        'mono-meta': ['12px', { lineHeight: '18px', fontWeight: '400' }],
        // Legacy scale — still used by Landing; remove when Landing is rebuilt
        'headline-xl': ['36px', { lineHeight: '44px', fontWeight: '700', letterSpacing: '-0.02em' }],
        'headline-lg': ['28px', { lineHeight: '36px', fontWeight: '600', letterSpacing: '-0.01em' }],
        'headline-lg-mobile': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'headline-md': ['20px', { lineHeight: '28px', fontWeight: '600' }],
        'body-lg': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'body-md': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'label-md': ['12px', { lineHeight: '16px', fontWeight: '500', letterSpacing: '0.05em' }],
        'code-sm': ['13px', { lineHeight: '18px', fontWeight: '400' }],
      },
      borderRadius: {
        sm: '0.125rem',
        DEFAULT: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px',
      },
      spacing: {
        base: '4px',
        xs: '4px',
        sm: '8px',
        md: '16px',
        lg: '24px',
        xl: '32px',
        'container-max': '1440px',
        gutter: '20px',
      },
      boxShadow: {
        // Approved: small elevation for overlays only. No resting/glow shadows.
        'tonal-low': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'tonal-med': '0 1px 2px 0 rgb(0 0 0 / 0.06)',
        'tonal-high': '0 1px 2px rgba(0, 0, 0, 0.06)',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(192, 193, 255, 0.55)' },
          '50%':      { boxShadow: '0 0 0 10px rgba(192, 193, 255, 0.00)' },
        },
        'fade-in':   { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-out':  { from: { opacity: '1' }, to: { opacity: '0' } },
        'zoom-in-95':{ from: { transform: 'scale(0.95)' }, to: { transform: 'scale(1)' } },
        'zoom-out-95':{ from: { transform: 'scale(1)' }, to: { transform: 'scale(0.95)' } },
        'slide-in-from-top-2':    { from: { transform: 'translateY(-8px)' }, to: { transform: 'translateY(0)' } },
        'slide-in-from-bottom-2': { from: { transform: 'translateY(8px)' },  to: { transform: 'translateY(0)' } },
        'slide-in-from-left-2':   { from: { transform: 'translateX(-8px)' }, to: { transform: 'translateX(0)' } },
        'slide-in-from-right-2':  { from: { transform: 'translateX(8px)' },  to: { transform: 'translateX(0)' } },
      },
      animation: {
        'pulse-glow': 'pulse-glow 3s ease-in-out infinite',
        'fade-in':    'fade-in 0.2s ease-out',
        'fade-out':   'fade-out 0.2s ease-out',
        'zoom-in-95': 'zoom-in-95 0.2s ease-out',
        'zoom-out-95':'zoom-out-95 0.2s ease-out',
        'slide-in-from-top-2':    'slide-in-from-top-2 0.2s ease-out',
        'slide-in-from-bottom-2': 'slide-in-from-bottom-2 0.2s ease-out',
        'slide-in-from-left-2':   'slide-in-from-left-2 0.2s ease-out',
        'slide-in-from-right-2':  'slide-in-from-right-2 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
