/**
 * Physically based sky: single-scattering Rayleigh + Mie atmosphere (Nishita-style ray march),
 * sun disc, procedural clouds, star field, phased moon and a day/night cycle.
 *
 * The same model runs on the CPU (SkyModel) to derive sun/moon light colour, ambient tint,
 * fog colour and auto-exposure targets so lighting and sky always agree.
 */
import { Mesh, SphereGeometry, MeshBasicNodeMaterial, BackSide, Vector3, Color, CubeRenderTarget, CubeCamera, Scene, HalfFloatType } from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, int, Loop, step, normalize, positionWorld, cameraPosition, dot, max, min, exp, pow, sqrt, smoothstep, mix, floor, fract, hash, sin, cos, abs, length, clamp, select, mx_fractal_noise_float, time, saturate, oneMinus, If } from 'three/tsl';
import { U } from './Uniforms.js';
import { clamp as cl, lerp, smoothstep as ss } from '../core/math.js';

// Atmosphere constants (metres). Scaled Earth for a punchier horizon at ground level.
const R_EARTH = 6371e3, R_ATMO = 6471e3;
const H_RAY = 8000, H_MIE = 1200;
const BETA_R = [ 5.5e-6, 13.0e-6, 22.4e-6 ];
const BETA_M = 21e-6;
const SUN_I = 22.0;

/* --------------------------------------------------------------------------------------------- */
/* CPU model                                                                                     */
/* --------------------------------------------------------------------------------------------- */

export class SkyModel {
	constructor() {
		this.hour = 12;
		this.sunDir = new Vector3( 0, 1, 0 );
		this.moonDir = new Vector3( 0, - 1, 0 );
		this.sunColor = new Color();
		this.moonColor = new Color( 0.55, 0.65, 0.9 );
		this.zenith = new Color();
		this.horizon = new Color();
		this.sunIntensity = 0;
		this.moonIntensity = 0;
		this.night = 0;
		this.latitude = 42 * Math.PI / 180;
	}

	/** Sun direction for an hour of the day (simple ecliptic: rises east, sets west). */
	setHour( hour ) {
		this.hour = ( ( hour % 24 ) + 24 ) % 24;
		const a = ( this.hour - 12 ) / 24 * Math.PI * 2;      // hour angle
		const decl = 18 * Math.PI / 180;                       // summer-ish declination
		const lat = this.latitude;
		const elev = Math.asin( Math.sin( lat ) * Math.sin( decl ) + Math.cos( lat ) * Math.cos( decl ) * Math.cos( a ) );
		const az = Math.atan2( Math.sin( a ), Math.cos( a ) * Math.sin( lat ) - Math.tan( decl ) * Math.cos( lat ) );
		this.sunDir.set( Math.sin( az ) * Math.cos( elev ), Math.sin( elev ), - Math.cos( az ) * Math.cos( elev ) ).normalize();
		// moon roughly opposite the sun, tilted so both are rarely at the horizon together
		this.moonDir.set( - this.sunDir.x * 0.9, - this.sunDir.y * 0.9 + 0.25, - this.sunDir.z * 0.9 ).normalize();
		this._computeLight();
	}

	_transmittance( dir, out ) {
		// optical depth from the ground along `dir` to the top of the atmosphere (16 steps)
		const origin = [ 0, R_EARTH + 50, 0 ];
		const b = 2 * ( origin[ 1 ] * dir.y );
		const c = origin[ 1 ] * origin[ 1 ] - R_ATMO * R_ATMO;
		const t = ( - b + Math.sqrt( Math.max( 0, b * b - 4 * c ) ) ) / 2;
		const steps = 16, ds = t / steps;
		let odR = 0, odM = 0;
		for ( let i = 0; i < steps; i ++ ) {
			const s = ( i + 0.5 ) * ds;
			const y = origin[ 1 ] + dir.y * s;
			const h = Math.sqrt( ( dir.x * s ) ** 2 + y * y + ( dir.z * s ) ** 2 ) - R_EARTH;
			odR += Math.exp( - h / H_RAY ) * ds;
			odM += Math.exp( - h / H_MIE ) * ds;
		}
		for ( let k = 0; k < 3; k ++ ) out[ k ] = Math.exp( - ( BETA_R[ k ] * odR + BETA_M * 1.1 * odM ) );
		return out;
	}

	_computeLight() {
		const s = this.sunDir;
		const tr = [ 1, 1, 1 ];
		if ( s.y > - 0.1 ) this._transmittance( new Vector3( s.x, Math.max( s.y, 0.005 ), s.z ).normalize(), tr );
		const up = ss( - 0.06, 0.12, s.y );
		this.sunColor.setRGB( tr[ 0 ], tr[ 1 ], tr[ 2 ] );
		this.sunIntensity = 3.6 * up;
		this.night = 1 - ss( - 0.12, 0.05, s.y );
		this.moonIntensity = 0.16 * ss( 0.0, 0.2, this.moonDir.y ) * this.night;
		// sky colours: sample the sky model at the zenith and at the horizon (toward the sun)
		this.zenith.setRGB( ...this.skyColor( new Vector3( 0, 1, 0 ) ) );
		const hz = new Vector3( s.x, 0.02, s.z ).normalize();
		this.horizon.setRGB( ...this.skyColor( hz ) );
	}

	/** Approximate sky radiance in a direction (CPU version of the shader, fewer steps). */
	skyColor( dir ) {
		const origin = [ 0, R_EARTH + 50, 0 ];
		const sun = this.sunDir;
		const b = 2 * ( origin[ 1 ] * dir.y ), c = origin[ 1 ] ** 2 - R_ATMO ** 2;
		const tMax = ( - b + Math.sqrt( Math.max( 0, b * b - 4 * c ) ) ) / 2;
		const steps = 8, ds = tMax / steps;
		const mu = dir.dot( sun );
		const phR = 3 / ( 16 * Math.PI ) * ( 1 + mu * mu );
		const g = 0.76;
		const phM = 3 / ( 8 * Math.PI ) * ( ( 1 - g * g ) * ( 1 + mu * mu ) ) / ( ( 2 + g * g ) * Math.pow( 1 + g * g - 2 * g * mu, 1.5 ) );
		let odR = 0, odM = 0;
		const sumR = [ 0, 0, 0 ], sumM = [ 0, 0, 0 ];
		const tr = [ 0, 0, 0 ];
		for ( let i = 0; i < steps; i ++ ) {
			const t = ( i + 0.5 ) * ds;
			const px = dir.x * t, py = origin[ 1 ] + dir.y * t, pz = dir.z * t;
			const h = Math.sqrt( px * px + py * py + pz * pz ) - R_EARTH;
			const dR = Math.exp( - h / H_RAY ) * ds, dM = Math.exp( - h / H_MIE ) * ds;
			odR += dR; odM += dM;
			// light transmittance from the sample toward the sun (4 steps)
			const bb = 2 * ( px * sun.x + py * sun.y + pz * sun.z ), cc = px * px + py * py + pz * pz - R_ATMO ** 2;
			const tl = ( - bb + Math.sqrt( Math.max( 0, bb * bb - 4 * cc ) ) ) / 2;
			let lR = 0, lM = 0;
			const dl = tl / 4;
			for ( let j = 0; j < 4; j ++ ) {
				const u = ( j + 0.5 ) * dl;
				const hh = Math.sqrt( ( px + sun.x * u ) ** 2 + ( py + sun.y * u ) ** 2 + ( pz + sun.z * u ) ** 2 ) - R_EARTH;
				lR += Math.exp( - hh / H_RAY ) * dl; lM += Math.exp( - hh / H_MIE ) * dl;
			}
			for ( let k = 0; k < 3; k ++ ) {
				tr[ k ] = Math.exp( - ( BETA_R[ k ] * ( odR + lR ) + BETA_M * 1.1 * ( odM + lM ) ) );
				sumR[ k ] += dR * tr[ k ]; sumM[ k ] += dM * tr[ k ];
			}
		}
		const out = [ 0, 0, 0 ];
		for ( let k = 0; k < 3; k ++ ) out[ k ] = SUN_I * ( sumR[ k ] * BETA_R[ k ] * phR + sumM[ k ] * BETA_M * phM );
		// faint night sky floor so the horizon never goes fully black
		out[ 0 ] += 0.004 * this.night; out[ 1 ] += 0.005 * this.night; out[ 2 ] += 0.009 * this.night;
		return out;
	}
}

/* --------------------------------------------------------------------------------------------- */
/* GPU sky                                                                                       */
/* --------------------------------------------------------------------------------------------- */

export class Sky {
	constructor( opts = {} ) {
		this.model = new SkyModel();
		this.uniforms = {
			sunDir: U.sunDir,
			moonDir: uniform( new Vector3( 0, - 1, 0 ) ),
			cloudCover: uniform( 0.3 ),
			cloudDark: uniform( 0 ),
			night: U.night,
			stars: uniform( 1 ),
			quality: uniform( 1 )
		};
		this.material = this._buildMaterial( opts.steps ?? 6, opts.lightSteps ?? 3 );
		this.dome = new Mesh( new SphereGeometry( 4800, 48, 24 ), this.material );
		this.dome.frustumCulled = false; this.dome.renderOrder = - 100; this.dome.name = 'sky';
		// environment capture: a second dome in its own scene rendered by a cube camera
		this.envScene = new Scene();
		this.envDome = new Mesh( this.dome.geometry, this.material );
		this.envDome.frustumCulled = false;
		this.envScene.add( this.envDome );
		this.envRT = new CubeRenderTarget( opts.envSize ?? 128, { type: HalfFloatType, generateMipmaps: false } );
		this.cubeCamera = new CubeCamera( 1, 10000, this.envRT );
		this.envScene.add( this.cubeCamera );
		this.envTimer = 0;
	}

	_buildMaterial( STEPS, LSTEPS ) {
		const u = this.uniforms;
		const mat = new MeshBasicNodeMaterial();
		mat.side = BackSide; mat.depthWrite = false; mat.fog = false;

		const betaR = vec3( ...BETA_R ), betaM = float( BETA_M );
		const rEarth = float( R_EARTH ), rAtmo = float( R_ATMO );

		// ray/sphere exit distance from inside the atmosphere
		const atmoExit = Fn( ( [ o, d ] ) => {
			const b = dot( o, d ).mul( 2.0 );
			const c = dot( o, o ).sub( rAtmo.mul( rAtmo ) );
			const disc = b.mul( b ).sub( c.mul( 4.0 ) );
			return b.negate().add( sqrt( max( disc, 0.0 ) ) ).mul( 0.5 );
		} );

		const skyRadiance = Fn( ( [ dir, sunDir ] ) => {
			const origin = vec3( 0.0, rEarth.add( 60.0 ), 0.0 );
			const tMax = atmoExit( origin, dir );
			const ds = tMax.div( float( STEPS ) );
			const mu = dot( dir, sunDir );
			const phR = float( 3.0 / ( 16.0 * Math.PI ) ).mul( mu.mul( mu ).add( 1.0 ) );
			const g = float( 0.76 ), g2 = g.mul( g );
			const phM = float( 3.0 / ( 8.0 * Math.PI ) ).mul( oneMinus( g2 ).mul( mu.mul( mu ).add( 1.0 ) ) ).div( float( 2.0 ).add( g2 ).mul( pow( float( 1.0 ).add( g2 ).sub( g.mul( 2.0 ).mul( mu ) ), 1.5 ) ) );
			const sumR = vec3( 0.0 ).toVar(), sumM = vec3( 0.0 ).toVar();
			const odR = float( 0.0 ).toVar(), odM = float( 0.0 ).toVar();
			Loop( { start: int( 0 ), end: int( STEPS ) }, ( { i } ) => {
				const t = float( i ).add( 0.5 ).mul( ds );
				const p = origin.add( dir.mul( t ) );
				const h = length( p ).sub( rEarth );
				const dR = exp( h.negate().div( H_RAY ) ).mul( ds ), dM = exp( h.negate().div( H_MIE ) ).mul( ds );
				odR.addAssign( dR ); odM.addAssign( dM );
				const tl = atmoExit( p, sunDir );
				const dl = tl.div( float( LSTEPS ) );
				const lR = float( 0.0 ).toVar(), lM = float( 0.0 ).toVar();
				Loop( { start: int( 0 ), end: int( LSTEPS ), name: 'j' }, ( { j } ) => {
					const q = p.add( sunDir.mul( float( j ).add( 0.5 ).mul( dl ) ) );
					const hh = length( q ).sub( rEarth );
					lR.addAssign( exp( hh.negate().div( H_RAY ) ).mul( dl ) );
					lM.addAssign( exp( hh.negate().div( H_MIE ) ).mul( dl ) );
				} );
				const tr = exp( betaR.mul( odR.add( lR ) ).add( betaM.mul( 1.1 ).mul( odM.add( lM ) ) ).negate() );
				sumR.addAssign( tr.mul( dR ) ); sumM.addAssign( tr.mul( dM ) );
			} );
			return sumR.mul( betaR ).mul( phR ).add( sumM.mul( betaM ).mul( phM ) ).mul( SUN_I );
		} );

		const stars = Fn( ( [ dir ] ) => {
			// 3D cell hash on the direction: a sparse field of points with varied brightness + twinkle
			const cell = floor( dir.mul( 220.0 ) );
			const h = hash( cell.x.add( cell.y.mul( 57.0 ) ).add( cell.z.mul( 113.0 ) ) );
			const h2 = hash( cell.x.add( cell.y.mul( 57.0 ) ).add( cell.z.mul( 113.0 ) ).add( 11.3 ) );
			const local = fract( dir.mul( 220.0 ) ).sub( 0.5 );
			const d = length( local );
			const star = smoothstep( 0.08, 0.0, d ).mul( step( 0.985, h ) ).mul( h2.mul( 1.5 ).add( 0.2 ) );
			const twinkle = sin( time.mul( h2.mul( 6.0 ).add( 2.0 ) ).add( h.mul( 100.0 ) ) ).mul( 0.3 ).add( 0.8 );
			const tint = mix( vec3( 1.0, 0.9, 0.8 ), vec3( 0.8, 0.9, 1.0 ), h2 );
			// milky way band
			const band = exp( abs( dir.x.mul( 0.6 ).add( dir.y.mul( 0.8 ) ) ).mul( - 6.0 ) ).mul( mx_fractal_noise_float( dir.mul( 8.0 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 ) ).mul( 0.06 );
			return tint.mul( star ).mul( twinkle ).mul( 2.5 ).add( vec3( 0.5, 0.6, 0.8 ).mul( band ) );
		} );

		const moon = Fn( ( [ dir, moonDir, sunDir ] ) => {
			const angR = float( 0.012 );
			const cosA = dot( dir, moonDir );
			const o = dir.sub( moonDir.mul( cosA ) ).div( angR );
			const r2 = dot( o, o );
			const disc = smoothstep( 1.0, 0.92, r2 );
			const n = normalize( o.add( moonDir.mul( sqrt( max( oneMinus( r2 ), 0.0 ) ) ) ) );
			const lambert = max( dot( n, sunDir ), 0.0 );
			const maria = mx_fractal_noise_float( n.mul( 4.0 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 ).mul( 0.4 ).add( 0.7 );
			const glow = exp( oneMinus( cosA ).mul( - 400.0 ) ).mul( 0.4 );
			return vec3( 0.95, 0.95, 1.0 ).mul( disc.mul( lambert ).mul( maria ).mul( 6.0 ).add( glow ) );
		} );

		const clouds = Fn( ( [ dir, sunDir, baseSky ] ) => {
			// project onto a cloud plane at 1.5 km; two fbm octave sets for shape + detail
			const t = float( 1500.0 ).div( max( dir.y, 0.02 ) );
			const p = dir.mul( t ).xz.mul( 0.0004 ).add( time.mul( 0.004 ) );
			const shape = mx_fractal_noise_float( vec3( p, 0.0 ), 4, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
			const detail = mx_fractal_noise_float( vec3( p.mul( 4.0 ), 3.1 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
			const density = smoothstep( oneMinus( u.cloudCover ).mul( 0.8 ).add( 0.15 ), 1.0, shape.mul( 0.75 ).add( detail.mul( 0.25 ) ) );
			const horizonFade = smoothstep( 0.0, 0.18, dir.y );
			const a = density.mul( horizonFade );
			// lighting: top-lit by the sun, undersides take the sky colour; sunset tints the edges
			const sunUp = saturate( sunDir.y.mul( 4.0 ).add( 0.2 ) );
			const lit = max( dot( sunDir, vec3( 0.0, 1.0, 0.0 ) ), 0.0 ).mul( 0.6 ).add( 0.4 );
			const silver = pow( max( dot( dir, sunDir ), 0.0 ), 8.0 ).mul( 0.6 );
			const sunTint = U.sunColor.mul( U.sunIntensity ).mul( 0.35 ).mul( lit.add( silver ) ).mul( oneMinus( u.cloudDark.mul( 0.7 ) ) );
			const col = baseSky.mul( 0.9 ).add( sunTint ).mul( oneMinus( density.mul( 0.45 ) ) ).mul( mix( 1.0, 0.35, u.cloudDark ) );
			return vec4( col, a );
		} );

		mat.colorNode = Fn( () => {
			const dir = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			const sunDir = u.sunDir;
			// below the horizon: mirror slightly so the ground plane reads as haze
			const d2 = vec3( dir.x, max( dir.y, 0.0 ), dir.z ).toVar();
			d2.assign( normalize( d2 ) );
			let col = skyRadiance( d2, sunDir ).toVar();
			// multiple-scattering stand-in: single scattering leaves the daytime horizon too orange,
			// real skies whiten there. Blend toward a brighter neutral near the horizon by day.
			const whiten = pow( oneMinus( saturate( dir.y ) ), 6.0 ).mul( saturate( sunDir.y.mul( 3.0 ) ) );
			const lum = col.r.mul( 0.21 ).add( col.g.mul( 0.72 ) ).add( col.b.mul( 0.07 ) );
			col.assign( mix( col, vec3( lum ).mul( vec3( 1.25, 1.3, 1.45 ) ), whiten.mul( 0.55 ) ) );
			// sun disc with limb darkening
			const cosS = dot( dir, sunDir );
			const disc = smoothstep( 0.99985, 0.99995, cosS );
			const corona = pow( max( cosS, 0.0 ), 600.0 ).mul( 0.2 );
			const sunVis = smoothstep( - 0.03, 0.02, sunDir.y );
			col.addAssign( U.sunColor.mul( disc.mul( 40.0 ).add( corona.mul( 8.0 ) ) ).mul( sunVis ) );
			// night: stars + moon fade in as the sky darkens
			const nightAmt = smoothstep( 0.1, - 0.1, sunDir.y );
			const starMask = nightAmt.mul( u.stars ).mul( smoothstep( - 0.05, 0.15, dir.y ) );
			col.addAssign( stars( dir ).mul( starMask ) );
			col.addAssign( moon( dir, u.moonDir, sunDir ).mul( smoothstep( - 0.05, 0.05, u.moonDir.y ) ).mul( nightAmt.mul( 0.9 ).add( 0.1 ) ) );
			// clouds
			const c = clouds( dir, sunDir, col );
			col.assign( mix( col, c.rgb, c.a ) );
			// ground haze below the horizon
			const below = smoothstep( 0.0, - 0.08, dir.y );
			col.assign( mix( col, U.fogColor.mul( 0.9 ), below ) );
			return col;
		} )();
		return mat;
	}

	/** Advance time-of-day and push the model into the uniforms/lights. */
	update( hour, weather ) {
		const m = this.model;
		m.setHour( hour );
		U.sunDir.value.copy( m.sunDir );
		this.uniforms.moonDir.value.copy( m.moonDir );
		U.sunColor.value.copy( m.sunColor );
		U.sunIntensity.value = m.sunIntensity;
		U.night.value = m.night;
		U.skyZenith.value.copy( m.zenith );
		U.skyHorizon.value.copy( m.horizon );
		this.uniforms.cloudCover.value = weather?.cloud ?? 0.3;
		this.uniforms.cloudDark.value = weather?.rain ?? 0;
	}

	/** Render the sky into the environment cube (call sparingly — PMREM regeneration follows). */
	captureEnvironment( renderer ) {
		this.cubeCamera.update( renderer, this.envScene );
		this.envRT.texture.pmremVersion ++;
		return this.envRT.texture;
	}

	followCamera( camera ) { this.dome.position.copy( camera.position ); }
}
