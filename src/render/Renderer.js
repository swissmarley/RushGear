/**
 * Renderer wrapper — WebGPURenderer (falls back to WebGL2 automatically), scene graph roots,
 * sun + hemisphere lighting and a simple gradient sky. Day/night sky, CSM and the
 * post-processing chain are layered on in later systems (Sky.js, Lighting.js, PostFX.js).
 */
import { WebGPURenderer, Scene, Color, DirectionalLight, HemisphereLight, ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Mesh, SphereGeometry, MeshBasicNodeMaterial, BackSide, Vector3 } from 'three/webgpu';
import { mix, smoothstep, normalWorld, vec3, positionWorld, normalize, cameraPosition, max, float, pow } from 'three/tsl';
import { U } from './Uniforms.js';

/**
 * Compatibility shim: three passes the identity swizzle ('rgba') in every texture view
 * descriptor. Browsers that implemented an earlier draft of `GPUTextureComponentSwizzle`
 * throw on it, so strip the no-op value before it reaches the browser.
 */
function installCompatShims() {
	if ( typeof GPUTexture === 'undefined' || GPUTexture.prototype.__rushgearShim ) return;
	const orig = GPUTexture.prototype.createView;
	GPUTexture.prototype.createView = function ( desc ) {
		if ( desc && desc.swizzle === 'rgba' ) { const d = Object.assign( {}, desc ); delete d.swizzle; return orig.call( this, d ); }
		return orig.call( this, desc );
	};
	GPUTexture.prototype.__rushgearShim = true;
}

export class GameRenderer {
	constructor( canvas, settings ) {
		this.canvas = canvas;
		this.settings = settings;
		this.renderer = new WebGPURenderer( { canvas, antialias: false, powerPreference: 'high-performance', forceWebGL: false } );
		this.scene = new Scene();
		this.scene.background = new Color( 0x6b8fc7 );
		this.backend = 'unknown';
	}

	async init() {
		installCompatShims();
		await this.renderer.init();
		this.backend = this.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
		const r = this.renderer;
		r.toneMapping = ACESFilmicToneMapping;
		r.toneMappingExposure = 1.0;
		r.outputColorSpace = SRGBColorSpace;
		r.shadowMap.enabled = true;
		r.shadowMap.type = PCFSoftShadowMap;
		this.applyQuality( this.settings.quality );
		this._buildLights();
		this._buildSky();
		window.addEventListener( 'resize', () => this.resize() );
		this.resize();
	}

	applyQuality( q ) {
		const dpr = Math.min( window.devicePixelRatio || 1, q.maxPixelRatio );
		this.renderer.setPixelRatio( dpr );
		this.resize();
	}

	resize() {
		const w = window.innerWidth, h = window.innerHeight;
		this.renderer.setSize( w, h, false );
		this.onResize?.( w / h );
	}

	_buildLights() {
		const sun = new DirectionalLight( 0xffffff, 3.0 );
		sun.position.set( 200, 300, 100 );
		sun.castShadow = true;
		const sh = sun.shadow;
		sh.mapSize.set( 2048, 2048 );
		sh.camera.near = 1; sh.camera.far = 600;
		sh.camera.left = - 90; sh.camera.right = 90; sh.camera.top = 90; sh.camera.bottom = - 90;
		sh.bias = - 0.0005; sh.normalBias = 0.05;
		this.sun = sun;
		this.scene.add( sun ); this.scene.add( sun.target );
		this.hemi = new HemisphereLight( 0x9fbfff, 0x506030, 0.8 );
		this.scene.add( this.hemi );
	}

	_buildSky() {
		// Placeholder gradient dome (replaced by the physically based sky in Sky.js)
		const mat = new MeshBasicNodeMaterial();
		const dir = normalize( positionWorld.sub( cameraPosition ) );
		const h = dir.y;
		const sunAmount = pow( max( dir.dot( U.sunDir ), 0.0 ), 48.0 );
		mat.colorNode = mix( U.skyHorizon, U.skyZenith, smoothstep( - 0.05, 0.5, h ) ).add( U.sunColor.mul( sunAmount ).mul( 0.6 ) );
		mat.side = BackSide;
		mat.depthWrite = false;
		mat.fog = false;
		const dome = new Mesh( new SphereGeometry( 5000, 32, 16 ), mat );
		dome.name = 'skydome';
		dome.frustumCulled = false;
		dome.renderOrder = - 100;
		this.skyDome = dome;
		this.scene.add( dome );
	}

	/** Keep the shadow frustum centred around the player each frame. */
	updateShadowTarget( target ) {
		const s = this.sun;
		s.target.position.copy( target );
		s.position.copy( target ).add( this._sunOffset || ( this._sunOffset = new Vector3( 120, 180, 60 ) ) );
		s.target.updateMatrixWorld();
	}

	render( camera ) {
		this.skyDome.position.copy( camera.position );
		this.renderer.render( this.scene, camera );
	}
}
