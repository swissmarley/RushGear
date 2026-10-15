/**
 * Scene lighting: one shadow-casting directional light (sun by day, moon by night) with
 * 4-cascade CSM, sky-driven hemisphere fill, image-based lighting from the live sky, and
 * pools of point/spot lights that are re-assigned every frame to the nearest lamps and
 * headlights (fixed pool sizes keep the shader permutation stable).
 */
import { DirectionalLight, HemisphereLight, PointLight, SpotLight, Vector3, Color, Object3D } from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { U } from './Uniforms.js';
import { clamp, damp, lerp } from '../core/math.js';

const _v = new Vector3(), _v2 = new Vector3();

export class Lighting {
	constructor( scene, quality ) {
		this.scene = scene;
		this.quality = quality;
		this.sun = new DirectionalLight( 0xffffff, 3 );
		this.sun.position.set( 100, 200, 50 );
		this.sun.target.position.set( 0, 0, 0 );
		scene.add( this.sun ); scene.add( this.sun.target );
		this.hemi = new HemisphereLight( 0x8fb8ff, 0x3a3a30, 0.35 );
		scene.add( this.hemi );
		this.csm = null;
		this._setupShadows( quality );
		// pools
		this.pointPool = []; this.spotPool = [];
		for ( let i = 0; i < 12; i ++ ) { const l = new PointLight( 0xffffff, 0, 30, 2 ); l.visible = true; scene.add( l ); this.pointPool.push( l ); }
		for ( let i = 0; i < 8; i ++ ) {
			const l = new SpotLight( 0xffffff, 0, 90, 0.45, 0.5, 1.6 );
			l.target = new Object3D(); scene.add( l ); scene.add( l.target ); this.spotPool.push( l );
		}
		this.lampSources = [];
		this.exposure = 1;
		this.exposureTarget = 1;
	}

	_setupShadows( q ) {
		const sun = this.sun;
		sun.castShadow = !! q.shadows;
		const size = q.shadowMapSize || 2048;
		sun.shadow.mapSize.set( size, size );
		sun.shadow.camera.near = 1; sun.shadow.camera.far = 1000;
		sun.shadow.bias = - 0.00025; sun.shadow.normalBias = 0.03;
		if ( this.csm ) { this.csm.dispose(); this.csm = null; }
		if ( q.shadows ) {
			this.csm = new CSMShadowNode( sun, { cascades: q.cascades || 4, maxFar: q.shadowFar || 300, mode: 'practical', lightMargin: 150 } );
			this.csm.fade = true;
			sun.shadow.shadowNode = this.csm;
		} else sun.shadow.shadowNode = null;
	}

	applyQuality( q ) { this.quality = q; this._setupShadows( q ); }

	setLampSources( list ) { this.lampSources = list; }

	/** Called every frame after the sky model has been updated. */
	update( dt, sky, camera, cars, playerVehicle ) {
		const m = sky.model;
		const useMoon = m.sunIntensity < 0.03 && m.moonIntensity > 0.001;
		const dir = useMoon ? m.moonDir : m.sunDir;
		// directional light follows the camera so the cascades stay centred
		this.sun.target.position.copy( camera.position );
		this.sun.position.copy( camera.position ).addScaledVector( dir, 400 );
		this.sun.target.updateMatrixWorld();
		if ( useMoon ) { this.sun.color.copy( m.moonColor ); this.sun.intensity = m.moonIntensity * 6; }
		else { this.sun.color.copy( m.sunColor ); this.sun.intensity = m.sunIntensity; }
		// hemisphere fill from the sky model (IBL carries most of it when the env map is live)
		this.hemi.color.copy( m.zenith ).multiplyScalar( 1.2 ).add( new Color( 0.02, 0.02, 0.03 ) );
		this.hemi.groundColor.copy( U.fogColor.value ).multiplyScalar( 0.35 );
		this.hemi.intensity = 0.25 + 0.3 * ( 1 - m.night );
		if ( this.csm && this.csm.camera ) this.csm.updateFrustums();

		// --- point light pool → nearest lamps (only when it is dark enough to matter)
		const lampBoost = clamp( m.night * 1.5 + ( playerVehicle?.proj.tunnel ? 1 : 0 ), 0, 1 );
		const sources = this.lampSources;
		if ( sources.length && lampBoost > 0.02 ) {
			const cam = camera.position;
			const near = sources.map( ( s ) => ( { s, d: s.pos.distanceToSquared( cam ) } ) ).sort( ( a, b ) => a.d - b.d ).slice( 0, this.pointPool.length );
			for ( let i = 0; i < this.pointPool.length; i ++ ) {
				const l = this.pointPool[ i ], n = near[ i ];
				if ( ! n ) { l.intensity = 0; continue; }
				l.position.copy( n.s.pos );
				l.color.setRGB( ...n.s.color );
				l.distance = n.s.range;
				l.intensity = n.s.intensity * lampBoost * ( n.s.tunnel ? 1 : 1 );
			}
		} else for ( const l of this.pointPool ) l.intensity = 0;

		// --- spot light pool → headlights of the closest cars (player gets two)
		const headOn = clamp( m.night * 2 + ( U.rain.value > 0.3 ? 0.6 : 0 ) + ( playerVehicle?.proj.tunnel ? 1 : 0 ), 0, 1 );
		let si = 0;
		if ( headOn > 0.02 && cars ) {
			const sorted = cars.slice().sort( ( a, b ) => a.root.position.distanceToSquared( camera.position ) - b.root.position.distanceToSquared( camera.position ) );
			for ( const car of sorted ) {
				if ( si >= this.spotPool.length ) break;
				const v = car.vehicle;
				const nose = v.def.stations[ v.def.stations.length - 1 ];
				const sides = v.isPlayer ? [ 0.7, - 0.7 ] : [ 0 ];
				for ( const sx of sides ) {
					if ( si >= this.spotPool.length ) break;
					const l = this.spotPool[ si ++ ];
					_v.set( sx * nose.hw, nose.belt - v.def.cgHeight + 0.1, nose.z - 0.1 ).applyQuaternion( car.root.quaternion ).add( car.root.position );
					l.position.copy( _v );
					_v2.set( sx * 0.15, - 0.12, 1 ).normalize().applyQuaternion( car.root.quaternion );
					l.target.position.copy( _v ).addScaledVector( _v2, 30 );
					l.target.updateMatrixWorld();
					l.intensity = ( v.isPlayer ? 2600 : 2200 ) * headOn * ( car.uniforms.head.value > 0.5 ? 1 : 0 );
					l.color.setRGB( 1.0, 0.96, 0.88 );
					l.angle = v.isPlayer ? 0.42 : 0.5; l.penumbra = 0.5; l.distance = 110; l.decay = 1.7;
				}
			}
		}
		for ( ; si < this.spotPool.length; si ++ ) this.spotPool[ si ].intensity = 0;

		// --- auto exposure: a light meter driven by the sky model, tunnels and night
		const zenithLum = m.zenith.r * 0.21 + m.zenith.g * 0.72 + m.zenith.b * 0.07;
		const sunUp = clamp( m.sunDir.y / 0.35, 0, 1 );
		let target = 1.0 / ( 0.22 + zenithLum * 0.9 + sunUp * 0.9 );
		target = clamp( target, 0.7, 3.2 );
		if ( playerVehicle?.proj.tunnel ) target *= 1.8;
		this.exposureTarget = target;
		// eyes adapt faster to brightening than to darkening
		const rate = target > this.exposure ? 0.6 : 1.4;
		this.exposure = damp( this.exposure, target, rate, dt );
		U.exposure.value = this.exposure;
	}
}
