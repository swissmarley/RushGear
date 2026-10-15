import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/ — the deploy workflow sets VITE_BASE.
export default defineConfig( {
	base: process.env.VITE_BASE || '/',
	build: {
		target: 'esnext',
		sourcemap: false,
		chunkSizeWarningLimit: 4000
	},
	server: { port: 5173, host: true },
	// pre-bundle every three.js entry we use so the dev server never re-optimises mid-session
	optimizeDeps: {
		include: [
			'three', 'three/webgpu', 'three/tsl',
			'three/addons/utils/BufferGeometryUtils.js', 'three/addons/csm/CSMShadowNode.js',
			'three/addons/tsl/display/GTAONode.js', 'three/addons/tsl/display/SSRNode.js', 'three/addons/tsl/display/BloomNode.js',
			'three/addons/tsl/display/MotionBlur.js', 'three/addons/tsl/display/DepthOfFieldNode.js', 'three/addons/tsl/display/TRAANode.js',
			'three/addons/tsl/display/SMAANode.js'
		]
	}
} );
