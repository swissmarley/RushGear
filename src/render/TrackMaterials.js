/**
 * Materials for the track and terrain, all procedural (TSL).
 * The asphalt reacts to U.wetness/U.rain: darker albedo, mirror-like puddles, animated ripples.
 */
import { MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, DoubleSide, Color, FrontSide } from 'three/webgpu';
import { Fn, vec2, vec3, vec4, float, positionWorld, attribute, uv, mix, smoothstep, step, fract, abs, sin, max, min, clamp, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float, normalWorld, saturate, oneMinus, floor, hash, time, select, length } from 'three/tsl';
import { U } from './Uniforms.js';
import { proceduralBump } from './ProcTex.js';

const c = ( r, g, b ) => new Color().setRGB( r, g, b );

/* Asphalt ---------------------------------------------------------------------------------- */
export function makeAsphaltMaterial( biome ) {
	const mat = new MeshPhysicalNodeMaterial();
	const p = positionWorld;
	const along = attribute( 'along' );
	const u = uv().x; // 0 left → 1 right

	// macro + micro grain
	const grain = mx_noise_float( p.mul( 9.0 ) ).mul( 0.5 ).add( 0.5 );
	const patches = mx_fractal_noise_float( p.mul( 0.08 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
	const repairs = smoothstep( 0.62, 0.66, mx_noise_float( p.mul( 0.035 ).add( 13.0 ) ).mul( 0.5 ).add( 0.5 ) );

	// lane markings: edge lines + dashed centre line (not on the oval)
	const edgeLine = step( abs( u.sub( 0.5 ) ), 0.485 ).oneMinus().mul( step( 0.455, abs( u.sub( 0.5 ) ) ) );
	const centreDash = step( abs( u.sub( 0.5 ) ), 0.006 ).mul( step( 0.5, fract( along.div( 8.0 ) ) ) );
	const marking = biome.scenery === 'oval' ? edgeLine : max( edgeLine, centreDash );
	const markingWear = smoothstep( 0.3, 0.7, patches );

	// racing-line rubber: darker band in the middle thirds
	const rubber = smoothstep( 0.45, 0.0, abs( u.sub( 0.5 ) ).sub( 0.08 ) ).mul( 0.35 ).mul( smoothstep( 0.2, 0.8, patches ) );

	// puddles: low-frequency worley cells in surface dips, only when wet
	const puddleNoise = mx_worley_noise_float( p.mul( 0.12 ), 1.0, 0 );
	const puddleMask = smoothstep( 0.55, 0.35, puddleNoise ).mul( U.wetness ).mul( smoothstep( 0.48, 0.2, abs( u.sub( 0.5 ) ) ).oneMinus().mul( 0.6 ).add( 0.4 ) );
	const wetFilm = U.wetness.mul( 0.85 );

	const base = vec3( 0.075, 0.075, 0.08 ).mul( grain.mul( 0.5 ).add( 0.75 ) ).mul( patches.mul( 0.4 ).add( 0.8 ) );
	const repaired = vec3( 0.05, 0.05, 0.052 );
	let albedo = mix( base, repaired, repairs );
	albedo = albedo.mul( oneMinus( rubber ) );
	albedo = mix( albedo, vec3( 0.85, 0.85, 0.8 ).mul( markingWear.mul( 0.5 ).add( 0.5 ) ), marking.mul( markingWear.mul( 0.5 ).add( 0.5 ) ) );
	// wet darkening (water film saturates the surface)
	albedo = albedo.mul( oneMinus( wetFilm.mul( 0.55 ) ) ).mul( oneMinus( puddleMask.mul( 0.5 ) ) );

	mat.colorNode = albedo;
	const dryRough = float( 0.86 ).sub( marking.mul( 0.25 ) ).sub( rubber.mul( 0.15 ) ).add( grain.mul( 0.08 ) );
	mat.roughnessNode = mix( mix( dryRough, float( 0.35 ), wetFilm ), float( 0.04 ), puddleMask );
	mat.metalnessNode = float( 0 );
	// rain ripples inside puddles + fine asphalt bump
	const ripple = sin( p.x.mul( 40.0 ).add( time.mul( 9.0 ) ) ).mul( sin( p.z.mul( 37.0 ).sub( time.mul( 7.0 ) ) ) ).mul( U.rain ).mul( puddleMask ).mul( 0.02 );
	const bumpH = mx_noise_float( p.mul( 14.0 ) ).mul( 0.02 ).mul( oneMinus( puddleMask ) ).add( ripple );
	mat.normalNode = proceduralBump( bumpH, 1.0 );
	mat.clearcoatNode = puddleMask.mul( 0.8 ).add( wetFilm.mul( 0.3 ) );
	mat.clearcoatRoughnessNode = float( 0.05 );
	mat.side = FrontSide;
	mat.name = 'asphalt';
	return mat;
}

/* Kerbs ------------------------------------------------------------------------------------ */
export function makeKerbMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const along = attribute( 'along' );
	const p = positionWorld;
	const stripe = step( 0.5, fract( along.div( 4.0 ) ) );
	const dirt = mx_noise_float( p.mul( 3.0 ) ).mul( 0.5 ).add( 0.5 );
	const red = vec3( 0.65, 0.06, 0.04 ), white = vec3( 0.85, 0.85, 0.82 );
	mat.colorNode = mix( red, white, stripe ).mul( dirt.mul( 0.35 ).add( 0.7 ) ).mul( oneMinus( U.wetness.mul( 0.3 ) ) );
	mat.roughnessNode = mix( float( 0.6 ), float( 0.2 ), U.wetness );
	mat.metalnessNode = float( 0 );
	mat.name = 'kerb';
	return mat;
}

/* Runoff (grass / gravel / sand) ---------------------------------------------------------- */
export function makeRunoffMaterial( biome, kind ) {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const n1 = mx_fractal_noise_float( p.mul( 0.5 ), 4, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
	const n2 = mx_noise_float( p.mul( 6.0 ) ).mul( 0.5 ).add( 0.5 );
	const base = vec3( ...biome.runoff );
	let color;
	if ( kind === 'gravel' ) {
		color = mix( vec3( 0.45, 0.42, 0.38 ), vec3( 0.62, 0.58, 0.52 ), n2 ).mul( n1.mul( 0.4 ).add( 0.7 ) );
	} else if ( kind === 'sand' ) {
		color = mix( vec3( 0.72, 0.6, 0.4 ), vec3( 0.85, 0.75, 0.55 ), n1 ).mul( n2.mul( 0.2 ).add( 0.85 ) );
	} else if ( kind === 'concrete' ) {
		color = vec3( 0.42, 0.42, 0.43 ).mul( n1.mul( 0.3 ).add( 0.8 ) );
	} else {
		color = mix( base.mul( 0.7 ), base.mul( 1.3 ), n1 ).mul( n2.mul( 0.5 ).add( 0.6 ) );
	}
	mat.colorNode = color.mul( oneMinus( U.wetness.mul( 0.35 ) ) );
	mat.roughnessNode = mix( float( 0.95 ), float( 0.5 ), U.wetness );
	mat.normalNode = proceduralBump( mx_noise_float( p.mul( 5.0 ) ).mul( 0.15 ), 1.0 );
	mat.name = 'runoff';
	return mat;
}

/* Terrain ---------------------------------------------------------------------------------- */
export function makeTerrainMaterial( biome ) {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const g = biome.ground;
	const slope = oneMinus( saturate( normalWorld.y ) );
	const macro = mx_fractal_noise_float( p.mul( 0.02 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
	const micro = mx_noise_float( p.mul( 1.5 ) ).mul( 0.5 ).add( 0.5 );
	const grass = vec3( ...g.grass ), dirt = vec3( ...g.dirt ), rock = vec3( ...g.rock ), sand = vec3( ...g.sand );
	let col = mix( grass, dirt, smoothstep( 0.35, 0.75, macro ) );
	col = mix( col, rock, smoothstep( 0.25, 0.6, slope ) );
	if ( biome.sea ) col = mix( sand, col, smoothstep( - 2.0, 3.0, p.y ) );
	if ( biome.name === 'Mountain' ) col = mix( col, vec3( 0.9, 0.92, 0.95 ), smoothstep( 120.0, 180.0, p.y ).mul( oneMinus( slope ) ) );
	col = col.mul( micro.mul( 0.35 ).add( 0.8 ) );
	mat.colorNode = col.mul( oneMinus( U.wetness.mul( 0.3 ) ) );
	mat.roughnessNode = mix( float( 0.95 ), float( 0.6 ), U.wetness );
	mat.normalNode = proceduralBump( mx_noise_float( p.mul( 0.8 ) ).mul( 0.4 ).add( mx_noise_float( p.mul( 7.0 ) ).mul( 0.08 ) ), 1.0 );
	mat.name = 'terrain';
	return mat;
}

/* Barriers / structures -------------------------------------------------------------------- */
export function makeArmcoMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const spec = mx_noise_float( p.mul( 2.0 ) ).mul( 0.5 ).add( 0.5 );
	mat.colorNode = vec3( 0.62, 0.64, 0.66 ).mul( spec.mul( 0.3 ).add( 0.8 ) );
	mat.metalnessNode = float( 0.85 );
	mat.roughnessNode = spec.mul( 0.3 ).add( 0.35 );
	mat.side = DoubleSide;
	mat.name = 'armco';
	return mat;
}
export function makeConcreteMaterial( tint = [ 0.55, 0.55, 0.54 ] ) {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const n = mx_fractal_noise_float( p.mul( 0.7 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
	const stains = smoothstep( 0.6, 0.9, mx_noise_float( p.mul( 0.25 ) ).mul( 0.5 ).add( 0.5 ) );
	mat.colorNode = vec3( ...tint ).mul( n.mul( 0.3 ).add( 0.8 ) ).mul( oneMinus( stains.mul( 0.35 ) ) );
	mat.roughnessNode = float( 0.9 );
	mat.normalNode = proceduralBump( mx_noise_float( p.mul( 4.0 ) ).mul( 0.05 ), 1.0 );
	mat.side = DoubleSide;
	mat.name = 'concrete';
	return mat;
}
export function makeSaferMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const stripe = step( 0.5, fract( p.y.mul( 2.0 ) ) );
	mat.colorNode = mix( vec3( 0.85, 0.85, 0.85 ), vec3( 0.1, 0.3, 0.9 ), stripe );
	mat.roughnessNode = float( 0.6 );
	mat.side = DoubleSide;
	return mat;
}
export function makeTunnelMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const tiles = fract( p.mul( 0.5 ) );
	const grout = step( 0.96, max( tiles.x, tiles.y ) ).add( step( 0.96, tiles.z ) );
	const n = mx_noise_float( p.mul( 1.2 ) ).mul( 0.5 ).add( 0.5 );
	const soot = smoothstep( 0.5, 0.9, mx_fractal_noise_float( p.mul( 0.15 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 ) );
	mat.colorNode = vec3( 0.5, 0.5, 0.52 ).mul( n.mul( 0.3 ).add( 0.8 ) ).mul( oneMinus( saturate( grout ).mul( 0.5 ) ) ).mul( oneMinus( soot.mul( 0.55 ) ) );
	mat.roughnessNode = float( 0.7 );
	mat.side = DoubleSide;
	mat.name = 'tunnel';
	return mat;
}
export function makeLampMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.9, 0.9, 0.85 );
	mat.emissiveNode = vec3( 1.0, 0.95, 0.8 ).mul( 12.0 );
	mat.roughnessNode = float( 0.3 );
	return mat;
}
export function makeGantryMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.2, 0.2, 0.22 );
	mat.metalnessNode = float( 0.6 );
	mat.roughnessNode = float( 0.5 );
	return mat;
}
export function makeGantryPanelMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const u = uv();
	// chequered start/finish board
	const check = fract( u.x.mul( 24.0 ) ).step( 0.5 ).add( fract( u.y.mul( 2.0 ) ).step( 0.5 ) ).mod( 2.0 ).step( 0.5 );
	mat.colorNode = mix( vec3( 0.9 ), vec3( 0.05 ), check );
	mat.emissiveNode = mix( vec3( 0.9 ), vec3( 0.0 ), check ).mul( U.night.mul( 1.5 ) );
	mat.roughnessNode = float( 0.4 );
	return mat;
}
export function makePostMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.5, 0.52, 0.55 );
	mat.metalnessNode = float( 0.8 );
	mat.roughnessNode = float( 0.5 );
	return mat;
}

export function makeTrackMaterials( track ) {
	const biome = track.biome;
	return {
		asphalt: makeAsphaltMaterial( biome ),
		kerb: makeKerbMaterial(),
		runoff: makeRunoffMaterial( biome, track.def.runoff ),
		terrain: makeTerrainMaterial( biome ),
		armco: makeArmcoMaterial(),
		concrete: makeConcreteMaterial(),
		safer: makeSaferMaterial(),
		tunnel: makeTunnelMaterial(),
		lamp: makeLampMaterial(),
		gantry: makeGantryMaterial(),
		gantryPanel: makeGantryPanelMaterial(),
		post: makePostMaterial()
	};
}
