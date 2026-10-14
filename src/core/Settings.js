/**
 * Quality presets + adaptive quality controller.
 *
 * Ultra assumes an RTX 5090-class GPU at 4K: native pixel ratio, 4096² cascades, every post
 * effect, transmission glass, max particle pools, no aggressive LOD.
 */
import { Storage } from './Storage.js';

export const PRESETS = {
	low: {
		label: 'Low', pixelRatio: 1, maxPixelRatio: 1, shadows: true, shadowMapSize: 1024, cascades: 2, shadowFar: 150,
		ao: false, ssr: false, bloom: true, motionBlur: false, dof: false, godrays: false, haze: false, aa: 'none',
		particles: 0.25, transmission: false, terrainCell: 12, scenery: 0.4, envUpdate: 4, skidMarks: 600, grassBlades: 0, anisotropy: 2,
		volumetricFog: false
	},
	medium: {
		label: 'Medium', pixelRatio: 1, maxPixelRatio: 1.25, shadows: true, shadowMapSize: 2048, cascades: 3, shadowFar: 220,
		ao: true, ssr: false, bloom: true, motionBlur: true, dof: false, godrays: true, haze: true, aa: 'smaa',
		particles: 0.5, transmission: false, terrainCell: 8, scenery: 0.7, envUpdate: 2, skidMarks: 1500, grassBlades: 0.4, anisotropy: 4,
		volumetricFog: true
	},
	high: {
		label: 'High', pixelRatio: 1, maxPixelRatio: 1.5, shadows: true, shadowMapSize: 2048, cascades: 4, shadowFar: 300,
		ao: true, ssr: true, bloom: true, motionBlur: true, dof: true, godrays: true, haze: true, aa: 'traa',
		particles: 0.8, transmission: true, terrainCell: 6, scenery: 1.0, envUpdate: 1, skidMarks: 3000, grassBlades: 0.8, anisotropy: 8,
		volumetricFog: true
	},
	ultra: {
		label: 'Ultra', pixelRatio: 1, maxPixelRatio: 4, shadows: true, shadowMapSize: 4096, cascades: 4, shadowFar: 420,
		ao: true, ssr: true, bloom: true, motionBlur: true, dof: true, godrays: true, haze: true, aa: 'traa',
		particles: 1.0, transmission: true, terrainCell: 5, scenery: 1.3, envUpdate: 1, skidMarks: 6000, grassBlades: 1.0, anisotropy: 16,
		volumetricFog: true
	}
};

export class Settings {
	constructor() {
		const saved = Storage.get( 'settings', {} );
		this.preset = saved.preset || this._detectPreset();
		this.adaptive = saved.adaptive ?? true;
		this.targetFps = saved.targetFps ?? 60;
		this.volume = saved.volume ?? 0.8;
		this.music = saved.music ?? 0.5;
		this.aids = saved.aids ?? { abs: true, tc: true, autoGear: true };
		this.cameraMode = saved.cameraMode ?? 0;
		this.adaptiveLevel = 0;   // 0 = full preset, higher = effects dropped by the adaptive controller
		this.quality = this._compose();
		this.onChange = null;
		this._frameTimes = [];
		this._lastAdapt = performance.now();
	}

	_detectPreset() {
		const dpr = window.devicePixelRatio || 1;
		const px = window.innerWidth * window.innerHeight * dpr * dpr;
		if ( px > 3840 * 2160 * 0.8 ) return 'high';
		return 'high';
	}

	save() {
		Storage.set( 'settings', { preset: this.preset, adaptive: this.adaptive, targetFps: this.targetFps, volume: this.volume, music: this.music, aids: this.aids, cameraMode: this.cameraMode } );
	}

	setPreset( name ) {
		if ( ! PRESETS[ name ] ) return;
		this.preset = name;
		this.adaptiveLevel = 0;
		this.quality = this._compose();
		this.save();
		this.onChange?.( this.quality );
	}

	/** Apply adaptive downgrades on top of the base preset. Each level removes the most expensive remaining effect. */
	_compose() {
		const q = { ...PRESETS[ this.preset ], preset: this.preset };
		const steps = [
			( q ) => { q.ssr = false; },
			( q ) => { q.maxPixelRatio = Math.min( q.maxPixelRatio, 1.5 ); },
			( q ) => { q.dof = false; q.godrays = false; },
			( q ) => { q.shadowMapSize = Math.min( q.shadowMapSize, 2048 ); q.cascades = Math.min( q.cascades, 3 ); },
			( q ) => { q.motionBlur = false; q.haze = false; },
			( q ) => { q.ao = false; q.maxPixelRatio = Math.min( q.maxPixelRatio, 1 ); },
			( q ) => { q.aa = 'none'; q.particles *= 0.5; q.volumetricFog = false; }
		];
		for ( let i = 0; i < this.adaptiveLevel && i < steps.length; i ++ ) steps[ i ]( q );
		q.adaptiveLevel = this.adaptiveLevel;
		return q;
	}

	/** Feed per-frame timings; drop a level when the average frame time overshoots the target. */
	recordFrame( ms ) {
		if ( ! this.adaptive ) return;
		this._frameTimes.push( ms );
		if ( this._frameTimes.length < 90 ) return;
		const avg = this._frameTimes.reduce( ( a, b ) => a + b, 0 ) / this._frameTimes.length;
		this._frameTimes.length = 0;
		const target = 1000 / this.targetFps;
		const now = performance.now();
		if ( now - this._lastAdapt < 4000 ) return;
		if ( avg > target * 1.25 && this.adaptiveLevel < 7 ) {
			this.adaptiveLevel ++;
			this._lastAdapt = now;
			this.quality = this._compose();
			this.onChange?.( this.quality, 'down' );
		} else if ( avg < target * 0.6 && this.adaptiveLevel > 0 && now - this._lastAdapt > 15000 ) {
			this.adaptiveLevel --;
			this._lastAdapt = now;
			this.quality = this._compose();
			this.onChange?.( this.quality, 'up' );
		}
	}
}
