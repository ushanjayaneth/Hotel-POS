import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['icon.svg', 'images/*.jpg'],
    manifest: {
      name: 'DEMO HOTEL — Restaurant workspace', short_name: 'DEMO HOTEL',
      description: 'Restaurant point of sale and kitchen operations',
      theme_color: '#0d1114', background_color: '#0d1114', display: 'standalone',
      lang: 'en', start_url: '/',
      icons: [{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}],
    },
    workbox: {globPatterns:['**/*.{js,css,html,svg,woff2,jpg}'], maximumFileSizeToCacheInBytes: 4_000_000, navigateFallbackDenylist:[/^\/api\//], cleanupOutdatedCaches:true},
  })],
  server: {host:'0.0.0.0',port:5173,proxy:{'/api':{target:'http://127.0.0.1:3001',changeOrigin:false}}},
  build: {outDir:'dist',sourcemap:false,chunkSizeWarningLimit:800},
});
