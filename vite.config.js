import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': process.env.API_TARGET || 'http://localhost:3000',
      '/mock-np': process.env.API_TARGET || 'http://localhost:3000'
    }
  }
});
