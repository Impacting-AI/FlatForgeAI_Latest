import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({root:'spa',plugins:[react()],resolve:{alias:{'@':path.resolve('.')}},publicDir:path.resolve('public'),build:{outDir:path.resolve('dist-spa'),emptyOutDir:true}});
