import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Map server .env public Supabase values into the browser bundle as fallbacks
 * when `/api/public-config` fails. Never inject the service-role key.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const publicUrl = (
    env.SUPABASE_URL
    || env.VITE_SUPABASE_URL
    || env.NEXT_PUBLIC_SUPABASE_URL
    || ''
  ).trim();
  const publicAnonKey = (
    env.SUPABASE_ANON_KEY
    || env.VITE_SUPABASE_ANON_KEY
    || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || ''
  ).replace(/\s/g, '');

  return {
    plugins: [react()],
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: {
      'import.meta.env.YOURTURN_SUPABASE_URL': JSON.stringify(publicUrl),
      'import.meta.env.YOURTURN_SUPABASE_ANON_KEY': JSON.stringify(publicAnonKey),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(publicAnonKey),
      'import.meta.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(publicUrl),
      'import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(publicAnonKey),
    },
    build: {
      outDir: 'dist/client',
      emptyOutDir: false,
    },
  };
});
