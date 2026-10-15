/**
 * Renderer wrapper — WebGPURenderer (falls back to WebGL2 automatically), scene graph roots,
 * sun + hemisphere lighting and a simple gradient sky. Day/night sky, CSM and the
 * post-processing chain are layered on in later systems (Sky.js, Lighting.js, PostFX.js).
 */
import { WebGPURenderer, Scene, Color, ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, Vector3 } from 'three/webgpu';
import { U } from './Uniforms.js';
import { Sky } from './Sky.js';
const clamp01 = ( v ) => Math.min( 1, Math.max( 0, v ) );
import { Lighting } from './Lighting.js';
import { PostFX } from './PostFX.js';

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
		this.usePost = true;
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
		r.shadowMap.type = PCFShadowMap;
		this.applyQuality( this.settings.quality );
		this._buildLights();
		window.addEventListener( 'resize', () => this.resize() );
		this.resize();
	}

	applyQuality( q ) {
		const dpr = Math.min( window.devicePixelRatio || 1, q.maxPixelRatio );
		this.renderer.setPixelRatio( dpr );
		this.resize();
		if ( this.lighting ) this.lighting.applyQuality( q );
		if ( this.post ) this.setupPost( this.postCamera );
	}

	resize() {
		const w = window.innerWidth, h = window.innerHeight;
		this.renderer.setSize( w, h, false );
		this.onResize?.( w / h );
	}

	_buildLights() {
		this.sky = new Sky( { steps: this.settings.quality.preset === 'low' ? 4 : 6, lightSteps: 3, envSize: 128 } );
		this.scene.add( this.sky.dome );
		this.lighting = new Lighting( this.scene, this.settings.quality );
		this.scene.environment = this.sky.envRT.texture;
		this.scene.environmentIntensity = 1.0;
		this.envFrame = 0;
		this.hour = 12;
		this.dayRate = 0;
		this.weather = { rain: 0, cloud: 0.3 };
		this.sky.update( this.hour, this.weather );
	}

	_buildSky() {}

	/** Per-track time of day, weather and fog. */
	setEnvironment( track ) {
		const def = track.def, biome = track.biome;
		this.hour = def.timeOfDay;
		this.dayRate = def.dayRate ?? 0;
		this.weather = { ...def.weather };
		U.rain.value = def.weather.rain; U.wetness.value = def.weather.rain;
		U.heat.value = biome.heat ? 1 : 0;
		const f = biome.fog;
		this.fogBase = new Color( ...f.color );
		U.fogDensity.value = f.density; U.fogHeight.value = f.height;
		this.biome = biome;
		this.post?.setGrade( biome.grade );
		this.sky.update( this.hour, this.weather );
		this._updateDerived();
		this.lighting.setLampSources( [] );
		this.envFrame = 0;
	}

	setLampSources( list ) { this.lighting.setLampSources( list ); }

	_updateDerived() {
		const m = this.sky.model;
		const day = 1 - m.night;
		// fog takes the horizon colour, darkened at night
		U.fogColor.value.copy( m.horizon ).lerp( this.fogBase || m.horizon, 0.35 ).multiplyScalar( 0.15 + 0.85 * day );
		U.neon.value = ( this.biome?.scenery === 'city' ? 1 : 0.35 ) * clamp01( m.night * 1.4 );
	}

	/** Advance the day/night cycle, weather and all lighting. */
	updateLighting( dt, camera, cars, playerVehicle ) {
		if ( this.dayRate ) this.hour = ( this.hour + dt * this.dayRate ) % 24;
		// weather: rain gusts around the track's base intensity; the road soaks and dries slowly
		const base = this.weather.rain || 0;
		const gust = base > 0 ? base * ( 0.8 + 0.2 * Math.sin( this.hour * 900 + Math.sin( this.hour * 2300 ) * 2 ) ) : 0;
		U.rain.value = gust;
		const wet = U.wetness.value;
		U.wetness.value = gust > wet ? wet + ( gust - wet ) * Math.min( 1, dt / 25 ) : wet + ( gust - wet ) * Math.min( 1, dt / 140 );
		U.rainLocal.value = gust * ( playerVehicle?.proj.tunnel ? 0 : 1 );
		this.sky.update( this.hour, this.weather );
		this._updateDerived();
		this.lighting.update( dt, this.sky, camera, cars, playerVehicle );
		// environment capture (PMREM) — spread out according to the quality budget
		const every = ( this.settings.quality.envUpdate || 1 ) * 6;
		if ( this.envFrame % every === 0 ) this.sky.captureEnvironment( this.renderer );
		this.envFrame ++;
		this.renderer.toneMappingExposure = U.exposure.value;
	}

	applyLightingQuality( q ) { this.lighting.applyQuality( q ); }

	/** Deprecated shim: shadows now follow the camera inside Lighting. */
	updateShadowTarget() {}

	/** Build (or rebuild) the post chain for a camera. */
	setupPost( camera ) {
		if ( this.post ) this.post.dispose();
		this.post = new PostFX( this.renderer, this.scene, camera, this.settings.quality );
		if ( this.biome ) this.post.setGrade( this.biome.grade );
		this.postCamera = camera;
	}

	render( camera, playerPos = null, speed = 0, dt = 1 / 60 ) {
		this.sky.followCamera( camera );
		if ( this.usePost ) {
			if ( ! this.post || this.postCamera !== camera ) this.setupPost( camera );
			this.post.update( camera, U.sunDir.value, playerPos, speed, dt );
			this.post.render();
		} else this.renderer.render( this.scene, camera );
	}
}
