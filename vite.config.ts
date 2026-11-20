import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const CSP =
  "default-src 'self'; img-src 'self' data: blob: r0bi-media:; media-src 'self' blob: data: r0bi-media:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // Strict CSP only for production builds (dev server needs inline HMR scripts).
      name: 'r0bi-csp',
      transformIndexHtml(html, ctx) {
        if (ctx.server) return html
        return html.replace('</head>', `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`)
      }
    }
  ],
  resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] }
})
