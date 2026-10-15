/**
 * Car materials: metal-flake clearcoat paint with panel gaps & damage, transmissive glass,
 * emissive light clusters, rubber, rims, carbon. All procedural TSL.
 */
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Color, DoubleSide, FrontSide, Vector4, Vector3 } from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, positionLocal, positionWorld, positionView, normalView, normalLocal, mix, smoothstep, step, fract, abs, sin, cos, max, min, floor, hash, mx_noise_float, mx_fractal_noise_float, normalize, saturate, oneMinus, length, uv, select, clamp, uniformArray, dot, pow } from 'three/tsl';
import { U } from '../render/Uniforms.js';

/** Per-car uniform set, created once per vehicle and shared by its materials. */
export function makeCarUniforms( def ) {
	const p = def.paint;
	return {
		color: uniform( new Color().setRGB( ...p.color ) ),
		flake: uniform( p.flake ?? 0.5 ),
		metallic: uniform( p.metallic ?? 0.6 ),
		clearcoat: uniform( p.clearcoat ?? 1 ),
		damage: uniform( 0 ),
		dirt: uniform( 0 ),
		head: uniform( 0 ),
		brake: uniform( 0 ),
		reverse: uniform( 0 ),
		// panel gap lines (z positions): doors x2, hood, trunk  + belt height for door gaps
		gaps: uniform( new Vector4( def.doors[ 0 ], def.doors[ 1 ], def.hoodLine, def.trunkLine ) ),
		belt: uniform( 0.9 ),
		ghost: uniform( 0 ) // >0 renders as a translucent ghost
	};
}

export function makePaintMaterial( cu, quality ) {
	const mat = new MeshPhysicalNodeMaterial();
	const p = positionLocal;

	// --- metal flakes: random per-cell normal perturbation under the clearcoat
	const cellSize = float( 0.004 );
	const cell = floor( p.div( cellSize ) );
	const h1 = hash( cell.x.add( cell.y.mul( 57.0 ) ).add( cell.z.mul( 113.0 ) ) );
	const h2 = hash( cell.x.add( cell.y.mul( 57.0 ) ).add( cell.z.mul( 113.0 ) ).add( 7.31 ) );
	const h3 = hash( cell.x.add( cell.y.mul( 57.0 ) ).add( cell.z.mul( 113.0 ) ).add( 19.7 ) );
	const dist = positionView.z.negate();
	const flakeFade = smoothstep( 25.0, 4.0, dist ); // flakes are sub-pixel far away → fade to avoid shimmer
	const flakeVec = vec3( h1.sub( 0.5 ), h2.sub( 0.5 ), h3.sub( 0.5 ) ).mul( cu.flake.mul( 0.16 ).mul( flakeFade ) );
	const sparkle = step( 0.985, h1 ).mul( cu.flake ).mul( flakeFade ).mul( 2.5 );

	// --- panel gaps
	const g = cu.gaps;
	const gapW = float( 0.006 );
	const lineGap = ( z ) => smoothstep( gapW.mul( 2.0 ), gapW, abs( p.z.sub( z ) ) );
	const belowBelt = step( p.y, cu.belt.add( 0.02 ) );
	const doorGap = max( lineGap( g.x ), lineGap( g.y ) ).mul( belowBelt ).mul( step( 0.3, p.y ) );
	const hoodGap = lineGap( g.z ).mul( step( 0.0, p.y.sub( 0.45 ) ) );
	const trunkGap = lineGap( g.w ).mul( step( 0.0, p.y.sub( 0.5 ) ) );
	// door bottom/top edges: horizontal gap at the rocker line between the two door lines
	const inDoor = step( g.x, p.z ).mul( step( p.z, g.y ) );
	const rockerGap = smoothstep( gapW.mul( 2.0 ), gapW, abs( p.y.sub( 0.33 ) ) ).mul( inDoor );
	const gap = saturate( doorGap.add( hoodGap ).add( trunkGap ).add( rockerGap ) );

	// --- damage: scuffs/scratches grow with the damage uniform
	const scratchNoise = mx_fractal_noise_float( p.mul( 60.0 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
	const scuff = smoothstep( oneMinus( cu.damage.mul( 0.9 ) ), 1.0, scratchNoise ).mul( cu.damage );
	// --- dirt: builds up low on the body
	const dirtMask = smoothstep( 0.9, 0.2, p.y ).mul( cu.dirt ).mul( mx_noise_float( p.mul( 8.0 ) ).mul( 0.5 ).add( 0.5 ) );

	let albedo = cu.color.mul( oneMinus( gap.mul( 0.9 ) ) );
	albedo = mix( albedo, vec3( 0.55, 0.55, 0.55 ), scuff.mul( 0.7 ) );
	albedo = mix( albedo, vec3( 0.25, 0.22, 0.18 ), dirtMask );
	albedo = albedo.add( sparkle.mul( 0.15 ) );
	mat.colorNode = mix( albedo, vec3( 0.2, 0.6, 1.0 ), cu.ghost );
	mat.metalnessNode = cu.metallic.mul( oneMinus( scuff ) ).mul( oneMinus( dirtMask ) );
	mat.roughnessNode = float( 0.42 ).add( gap.mul( 0.5 ) ).add( scuff.mul( 0.45 ) ).add( dirtMask.mul( 0.4 ) ).add( h2.mul( 0.04 ).mul( cu.flake ) );
	mat.normalNode = normalize( normalView.add( flakeVec ) );
	mat.clearcoatNode = cu.clearcoat.mul( oneMinus( scuff.mul( 0.8 ) ) ).mul( oneMinus( dirtMask ) ).mul( oneMinus( gap ) );
	mat.clearcoatRoughnessNode = float( 0.06 ).add( scuff.mul( 0.3 ) );
	mat.clearcoatNormalNode = normalView; // smooth coat over the flaked base layer
	mat.opacityNode = mix( float( 1 ), float( 0.35 ), cu.ghost );
	mat.transparent = false;
	mat.name = 'paint';
	return mat;
}

export function makeGlassMaterial( cu, quality ) {
	const mat = new MeshPhysicalNodeMaterial();
	mat.colorNode = vec3( 0.06, 0.07, 0.08 );
	mat.roughnessNode = float( 0.03 );
	mat.metalnessNode = float( 0 );
	mat.clearcoatNode = float( 1 );
	mat.clearcoatRoughnessNode = float( 0.02 );
	if ( quality.transmission ) {
		mat.transmission = 0.92;
		mat.thickness = 0.02;
		mat.ior = 1.5;
		mat.opacityNode = mix( float( 1 ), float( 0.25 ), cu.ghost );
	} else {
		mat.transparent = true;
		mat.opacityNode = mix( float( 0.72 ), float( 0.25 ), cu.ghost );
	}
	mat.side = FrontSide;
	mat.name = 'glass';
	return mat;
}

export function makeLightMaterial( cu, kind ) {
	const mat = new MeshStandardNodeMaterial();
	const p = positionLocal;
	if ( kind === 'head' ) {
		const lensCells = fract( p.y.mul( 60.0 ) );
		mat.colorNode = vec3( 0.75, 0.78, 0.8 ).mul( lensCells.mul( 0.15 ).add( 0.85 ) );
		mat.emissiveNode = vec3( 1.0, 0.96, 0.88 ).mul( cu.head.mul( 12.0 ).add( 0.05 ) );
		mat.roughnessNode = float( 0.08 );
		mat.metalnessNode = float( 0.6 );
	} else if ( kind === 'tail' ) {
		const ribs = step( 0.5, fract( p.x.mul( 80.0 ) ) ).mul( 0.1 ).add( 0.9 );
		mat.colorNode = vec3( 0.5, 0.02, 0.02 ).mul( ribs );
		mat.emissiveNode = vec3( 1.0, 0.03, 0.02 ).mul( cu.head.mul( 2.0 ).add( cu.brake.mul( 6.0 ) ).add( 0.03 ) );
		mat.roughnessNode = float( 0.12 );
		mat.metalnessNode = float( 0.3 );
	} else { // reverse
		mat.colorNode = vec3( 0.8, 0.8, 0.8 );
		mat.emissiveNode = vec3( 1.0, 1.0, 0.95 ).mul( cu.reverse.mul( 12.0 ) );
		mat.roughnessNode = float( 0.12 );
	}
	mat.opacityNode = mix( float( 1 ), float( 0.3 ), cu.ghost );
	mat.name = 'light-' + kind;
	return mat;
}

export function makeTyreMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const p = positionLocal;
	const tread = step( 0.5, fract( p.x.mul( 40.0 ) ) ).mul( step( 0.3, fract( p.y.mul( 25.0 ).add( p.z.mul( 25.0 ) ) ) ) );
	const sidewallText = smoothstep( 0.02, 0.0, abs( fract( p.y.mul( 6.0 ) ).sub( 0.5 ) ) ).mul( 0.05 );
	mat.colorNode = vec3( 0.025, 0.025, 0.027 ).add( tread.mul( 0.01 ) ).add( sidewallText );
	mat.roughnessNode = float( 0.82 ).sub( U.wetness.mul( 0.3 ) );
	mat.metalnessNode = float( 0 );
	mat.name = 'tyre';
	return mat;
}

export function makeRimMaterial( tint = [ 0.75, 0.75, 0.78 ] ) {
	// brushed alloy: anisotropic highlights stretched around the rim
	const mat = new MeshPhysicalNodeMaterial();
	const p = positionLocal;
	const brush = fract( length( p.yz ).mul( 400.0 ) ).mul( 0.06 ).add( 0.94 );
	mat.colorNode = vec3( ...tint ).mul( brush );
	mat.metalnessNode = float( 0.95 );
	mat.roughnessNode = float( 0.32 );
	mat.anisotropyNode = vec2( 0.85, 0.0 );
	mat.clearcoatNode = float( 0.6 );
	mat.clearcoatRoughnessNode = float( 0.15 );
	mat.name = 'rim';
	return mat;
}

export function makeBrakeDiscMaterial() {
	const mat = new MeshPhysicalNodeMaterial();
	const p = positionLocal;
	const r = length( p.xz );
	const rings = fract( r.mul( 120.0 ) ).mul( 0.1 ).add( 0.9 );
	mat.colorNode = vec3( 0.45, 0.45, 0.47 ).mul( rings );
	mat.metalnessNode = float( 0.9 );
	mat.roughnessNode = float( 0.45 );
	mat.anisotropyNode = vec2( 0.9, 0.0 ); // radial machining marks
	return mat;
}

export function makeCalliperMaterial( tint = [ 0.8, 0.1, 0.05 ] ) {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( ...tint );
	mat.roughnessNode = float( 0.35 );
	mat.metalnessNode = float( 0.2 );
	return mat;
}

export function makeCarbonMaterial() {
	const mat = new MeshPhysicalNodeMaterial();
	const p = positionLocal;
	const weave = step( 0.5, fract( p.x.mul( 150.0 ) ) ).add( step( 0.5, fract( p.z.mul( 150.0 ) ) ) ).mod( 2.0 );
	mat.colorNode = mix( vec3( 0.03 ), vec3( 0.09 ), weave );
	mat.roughnessNode = float( 0.3 );
	mat.metalnessNode = float( 0.2 );
	mat.clearcoatNode = float( 1 );
	mat.clearcoatRoughnessNode = float( 0.08 );
	mat.name = 'carbon';
	return mat;
}

export function makeInteriorMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.04, 0.04, 0.045 );
	mat.roughnessNode = float( 0.95 );
	mat.name = 'interior';
	return mat;
}

export function makeChromeMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.9, 0.9, 0.92 );
	mat.metalnessNode = float( 1 );
	mat.roughnessNode = float( 0.15 );
	return mat;
}

export function makeDarkPlasticMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.03, 0.03, 0.032 );
	mat.roughnessNode = float( 0.6 );
	mat.metalnessNode = float( 0 );
	return mat;
}

/** Materials shared by every car instance (no per-car uniforms). */
let _shared = null;
export function sharedCarMaterials() {
	if ( ! _shared ) {
		_shared = {
			tyre: makeTyreMaterial(), rim: makeRimMaterial(), disc: makeBrakeDiscMaterial(), calliper: makeCalliperMaterial(),
			carbon: makeCarbonMaterial(), interior: makeInteriorMaterial(), chrome: makeChromeMaterial(), plastic: makeDarkPlasticMaterial()
		};
	}
	return _shared;
}
