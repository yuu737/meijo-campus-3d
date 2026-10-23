import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Direct Cloudflare static build, independent of the old Sites development host.
export default defineConfig({plugins:[react()],publicDir:false,css:{postcss:{plugins:[]}},
  build:{target:'es2022',sourcemap:false}});
