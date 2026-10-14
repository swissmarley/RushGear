import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/ — the deploy workflow sets VITE_BASE.
export default defineConfig( {
	base: process.env.VITE_BASE || '/',
	build: {
		target: 'esnext',
		sourcemap: false,
		chunkSizeWarningLimit: 4000
	},
	server: { port: 5173, host: true }
} );
