/**
 * Post-processing chain (RenderPipeline + TSL):
 *
 *   scene (MRT: color, view normal, velocity, metal/rough)
 *     → GTAO → SSR → volumetric height fog + sun in-scatter → screen-space god rays
 *     → bloom (Karis-style firefly suppression) → DOF → velocity motion blur
 *     → TRAA / SMAA → tone mapping (auto-exposure) → colour grading + film grain + vignette
 *     → heat haze
 *
 * Every stage is optional (quality presets / adaptive quality); the chain is rebuilt on change.
 */
import { RenderPipeline, Vector2, Vector3, Color } from 'three/webgpu';
import { pass, mrt, output, normalView, velocity, metalness, roughness, vec2, vec3, vec4, float, int, uniform, Fn, uv, screenUV, screenSize, mix, smoothstep, max, min, pow, exp, length, normalize, dot, clamp, saturate, luminance, hash, time, Loop, convertToTexture, renderOutput, cameraProjectionMatrixInverse, cameraWorldMatrix, sin, cos, fract, oneMinus, select, abs, step } from 'three/tsl';
import { getViewPosition } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { U } from './Uniforms.js';

const _v = new Vector3();

export class PostFX {
	constructor( renderer, scene, camera, quality ) {
		this.renderer = renderer; this.scene = scene; this.camera = camera;
		this.u = {
			sunScreen: uniform( new Vector2( 0.5, 0.5 ) ),
			sunVisible: uniform( 0 ),
			focusDistance: uniform( 8 ),
			bokeh: uniform( 0.7 ),
			motionStrength: uniform( 1 ),
			lift: uniform( new Vector3( 0, 0, 0 ) ), gamma: uniform( new Vector3( 1, 1, 1 ) ), gain: uniform( new Vector3( 1, 1, 1 ) ),
			saturation: uniform( 1.1 ), contrast: uniform( 1.05 ), grain: uniform( 0.035 ), vignette: uniform( 0.35 ),
			bloomStrength: uniform( 0.22 )
		};
		this.pipeline = null;
		this.build( quality );
	}

	setGrade( g ) {
		this.u.lift.value.set( ...g.lift ); this.u.gamma.value.set( ...g.gamma ); this.u.gain.value.set( ...g.gain );
		this.u.saturation.value = g.saturation; this.u.contrast.value = g.contrast;
	}

	build( quality ) {
		this.dispose();
		const q = this.quality = quality;
		const camera = this.camera;
		const pipeline = new RenderPipeline( this.renderer );
		pipeline.outputColorTransform = false; // we tone-map ourselves so grading happens in display space

		const scenePass = pass( this.scene, camera );
		const mrtLayout = { output: output, normal: normalView, mr: vec2( metalness, roughness ) };
		if ( q.motionBlur || q.aa === 'traa' ) mrtLayout.velocity = velocity;
		scenePass.setMRT( mrt( mrtLayout ) );
		this.scenePass = scenePass;
		const color = scenePass.getTextureNode( 'output' );
		const depth = scenePass.getTextureNode( 'depth' );
		const normal = scenePass.getTextureNode( 'normal' );
		const mr = scenePass.getTextureNode( 'mr' );
		const vel = mrtLayout.velocity ? scenePass.getTextureNode( 'velocity' ) : null;
		const viewZ = scenePass.getViewZNode();

		let col = color.rgb;

		// --- GTAO (multiplied into the lit result; indirect-only would need a pre-pass)
		if ( q.ao ) {
			const aoNode = ao( depth, normal, camera );
			aoNode.resolutionScale = q.preset === 'ultra' ? 1 : 0.5;
			aoNode.radius.value = 1.2; aoNode.scale.value = 1.0; aoNode.samples.value = q.preset === 'ultra' ? 24 : 16; aoNode.thickness.value = 1.0;
			this.aoNode = aoNode;
			const aoTex = aoNode.getTextureNode();
			col = col.mul( mix( 1.0, aoTex.r, 0.85 ) );
		}

		// --- SSR (pre-weighted reflection colour → add)
		if ( q.ssr ) {
			const ssrNode = ssr( color, depth, normal, { metalnessNode: mr.r, roughnessNode: mr.g, reflectNonMetals: true, camera, binaryRefine: true } );
			ssrNode.resolutionScale = q.preset === 'ultra' ? 1 : 0.5;
			ssrNode.maxDistance.value = 140; ssrNode.thickness.value = 0.6; ssrNode.quality.value = q.preset === 'ultra' ? 0.9 : 0.5;
			this.ssrNode = ssrNode;
			col = col.add( ssrNode.rgb );
		}

		// --- view-space position / world data for fog & haze
		const viewPos = getViewPosition( screenUV, depth, cameraProjectionMatrixInverse ).toVar();
		const dist = length( viewPos ).toVar();
		const worldPos = cameraWorldMatrix.mul( vec4( viewPos, 1.0 ) ).xyz;
		const camWorld = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
		const viewDirW = normalize( worldPos.sub( camWorld ) );
		const skyMask = smoothstep( 3000.0, 4600.0, dist ).toVar();

		// --- volumetric height fog with sun in-scatter (exponential height density, analytic integral)
		if ( q.volumetricFog !== false ) {
			const H = U.fogHeight;
			const dy = worldPos.y.sub( camWorld.y );
			const camDensity = exp( camWorld.y.negate().div( H ).add( 0.1 ) ).clamp( 0.05, 3.0 );
			// ∫ exp(-y/H) along the ray  ≈ camDensity · (1 - exp(-dy/H)) / (dy/H)
			const k = dy.div( H );
			const integ = select( abs( k ).lessThan( 0.001 ), float( 1.0 ), oneMinus( exp( k.negate() ) ).div( k ) );
			const fogDist = min( dist, 2500.0 );
			const amount = oneMinus( exp( U.fogDensity.mul( fogDist ).mul( camDensity ).mul( integ ).negate() ) ).mul( oneMinus( skyMask ) ).toVar();
			const mu = dot( viewDirW, U.sunDir );
			const mie = pow( max( mu, 0.0 ), 10.0 ).mul( 0.6 ).add( pow( max( mu, 0.0 ), 2.0 ).mul( 0.12 ) );
			const fogCol = U.fogColor.add( U.sunColor.mul( U.sunIntensity ).mul( mie ).mul( 0.35 ) );
			col = mix( col, fogCol, amount );
		}

		// --- screen-space god rays: radial blur of the bright sky around the sun, occluded by geometry
		if ( q.godrays ) {
			const rayMask = Fn( () => {
				const toSun = dot( viewDirW, U.sunDir );
				const glow = pow( max( toSun, 0.0 ), 24.0 );
				return U.sunColor.mul( glow.mul( skyMask ).mul( this.u.sunVisible ) );
			} )();
			const maskTex = convertToTexture( rayMask );
			const rays = Fn( () => {
				const uvs = screenUV.toVar();
				const delta = this.u.sunScreen.sub( uvs ).mul( 1.0 / 48.0 ).toVar();
				const acc = vec3( 0.0 ).toVar();
				const weight = float( 1.0 ).toVar();
				const p = uvs.toVar();
				// jitter the start to hide banding
				p.addAssign( delta.mul( hash( uvs.x.mul( 1234.5 ).add( uvs.y.mul( 567.8 ) ) ) ) );
				Loop( { start: int( 0 ), end: int( 48 ) }, () => {
					p.addAssign( delta );
					acc.addAssign( maskTex.sample( p ).rgb.mul( weight ) );
					weight.mulAssign( 0.955 );
				} );
				return acc.mul( 1.0 / 48.0 ).mul( 1.6 ).mul( this.u.sunVisible );
			} )();
			col = col.add( rays );
		}

		// --- bloom with Karis-style firefly suppression on the input
		if ( q.bloom ) {
			const karis = col.div( luminance( col ).mul( 0.25 ).add( 1.0 ) ); // soften very bright pixels before blurring
			const bloomNode = bloom( vec4( karis, 1.0 ), 1.0, 0.65, 0.85 );
			this.bloomNode = bloomNode;
			col = col.add( bloomNode.rgb.mul( this.u.bloomStrength ) );
		}

		// --- depth of field (focus follows the player car)
		if ( q.dof ) {
			// focalLength = depth range that stays sharp (m); keep DOF subtle for a racing game
			col = dof( vec4( col, 1.0 ), viewZ, this.u.focusDistance, float( 90.0 ), this.u.bokeh ).rgb;
		}

		// --- velocity motion blur
		if ( q.motionBlur && vel ) {
			const colTex = convertToTexture( vec4( col, 1.0 ) );
			// velocity is in NDC units: convert to UV space (flip y), scale by shutter, clamp long streaks
			const vNdc = vel.xy.mul( vec2( 0.5, - 0.5 ) ).mul( this.u.motionStrength ).mul( 0.45 );
			const vLen = length( vNdc );
			const v2 = vNdc.mul( min( vLen, 0.03 ).div( max( vLen, 1e-5 ) ) );
			col = motionBlur( colTex, v2, int( q.preset === 'ultra' ? 16 : 10 ) ).rgb;
		}

		// --- anti-aliasing on the HDR composite
		let hdr = vec4( col, 1.0 );
		if ( q.aa === 'traa' && vel ) hdr = traa( hdr, depth, vel, camera );

		// --- tone mapping (renderer.toneMapping, exposure from the light meter) → display space
		let ldr = renderOutput( hdr ).rgb;
		if ( q.aa === 'smaa' ) ldr = smaa( vec4( ldr, 1.0 ) ).rgb;

		// --- colour grading: lift/gamma/gain, saturation, contrast, vignette, film grain, haze
		const graded = Fn( () => {
			const uvs = screenUV;
			let c = ldr;
			// heat haze: wobble the sampled image low on screen & far away
			if ( q.haze ) {
				const ldrTex = convertToTexture( vec4( ldr, 1.0 ) );
				const hazeMask = U.heat.mul( smoothstep( 0.62, 0.45, uvs.y ) ).mul( smoothstep( 40.0, 160.0, dist ) ).mul( oneMinus( skyMask ) );
				const wob = vec2( sin( uvs.y.mul( 140.0 ).add( time.mul( 4.0 ) ) ), cos( uvs.x.mul( 110.0 ).sub( time.mul( 3.0 ) ) ) ).mul( 0.0025 ).mul( hazeMask );
				c = ldrTex.sample( uvs.add( wob ) ).rgb;
			}
			const lift = this.u.lift, gamma = this.u.gamma, gain = this.u.gain;
			c = pow( max( c.mul( gain ).add( lift.mul( oneMinus( c ) ) ), 0.0 ), float( 1.0 ).div( gamma ) );
			const l = luminance( c );
			c = mix( vec3( l ), c, this.u.saturation );
			c = mix( vec3( 0.5 ), c, this.u.contrast );
			// vignette
			const d = length( uvs.sub( 0.5 ).mul( vec2( 1.0, 0.75 ) ) );
			c = c.mul( oneMinus( smoothstep( 0.45, 1.05, d ).mul( this.u.vignette ) ) );
			// film grain (luminance-weighted so shadows get the texture)
			const g = hash( uvs.x.mul( screenSize.x ).add( uvs.y.mul( screenSize.y ).mul( 1.37 ) ).add( fract( time ).mul( 100.0 ) ) ).sub( 0.5 );
			c = c.add( g.mul( this.u.grain ).mul( oneMinus( l ).mul( 0.7 ).add( 0.3 ) ) );
			return vec4( saturate( c ), 1.0 );
		} )();

		pipeline.outputNode = graded;
		this.pipeline = pipeline;
	}

	/** Per-frame data: sun screen position, focus distance, motion blur scaling. */
	update( camera, sunDir, playerPos, speed, dt = 1 / 60 ) {
		_v.copy( sunDir ).multiplyScalar( 1000 ).add( camera.position ).project( camera );
		const inFront = _v.z < 1 && sunDir.dot( _v.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion ) ) > 0;
		_v.copy( sunDir ).multiplyScalar( 1000 ).add( camera.position ).project( camera );
		this.u.sunScreen.value.set( _v.x * 0.5 + 0.5, 1 - ( _v.y * 0.5 + 0.5 ) );
		const edge = Math.max( Math.abs( _v.x ), Math.abs( _v.y ) );
		this.u.sunVisible.value = inFront && sunDir.y > - 0.05 ? Math.max( 0, 1 - Math.max( 0, edge - 0.9 ) * 2.5 ) * U.sunIntensity.value / 3.6 : 0;
		if ( playerPos ) this.u.focusDistance.value = camera.position.distanceTo( playerPos ) + 1.5;
		// velocities are per rendered frame: normalise to a 60 Hz shutter so low frame rates don't smear
		this.u.motionStrength.value = Math.min( 1, speed / 25 ) * Math.min( 1, ( 1 / 60 ) / Math.max( dt, 1 / 240 ) );
	}

	render() { this.pipeline.render(); }

	dispose() { if ( this.pipeline ) { this.pipeline.dispose(); this.pipeline = null; } }
}
