// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],

  css: [
    '@vue-flow/core/dist/style.css',
    '@vue-flow/core/dist/theme-default.css',
    '@vue-flow/controls/dist/style.css',
    '~/assets/css/main.css',
  ],

  // Force dark mode
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
    classSuffix: ''
  },

  devServer: {
    host: '127.0.0.1',
    port: 3939
  },

  runtimeConfig: {
    // Server-side only (set via env vars in production)
    projectsDir: process.env.PROJECTS_DIR || './projects',
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || ''
  },

  nitro: {
    experimental: {
      websocket: true
    }
  },

  // Security headers
  routeRules: {
    '/**': {
      headers: {
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-XSS-Protection': '1; mode=block'
      }
    }
  }
})
