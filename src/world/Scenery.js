/**
 * Biome scenery — everything beside the road is generated here from instanced procedural
 * geometry: trees, rocks, buildings, grandstands with crowds, light towers, boards,
 * tyre stacks, water. Density scales with the quality preset.
 */
import { Group, Mesh, InstancedMesh, Object3D, Color, Vector3, Matrix4, Quaternion, BoxGeometry, CylinderGeometry, ConeGeometry, SphereGeometry, IcosahedronGeometry, PlaneGeometry, TorusGeometry, Float32BufferAttribute, MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial, DoubleSide, InstancedBufferAttribute } from 'three/webgpu';
import { mergeGeometries as _mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** mergeGeometries that tolerates a mix of indexed and non-indexed parts. */
function mergeGeometries( parts ) {
	const anyNonIndexed = parts.some( ( g ) => g.index === null );
	if ( anyNonIndexed ) parts = parts.map( ( g ) => ( g.index ? g.toNonIndexed() : g ) );
	const merged = _mergeGeometries( parts );
	if ( ! merged ) throw new Error( 'Scenery: geometry merge failed' );
	return merged;
}
import { Fn, vec2, vec3, vec4, float, positionLocal, positionWorld, normalWorld, attribute, uv, mix, smoothstep, step, fract, abs, sin, cos, max, min, floor, hash, mx_noise_float, mx_fractal_noise_float, time, instanceIndex, saturate, oneMinus, cameraPosition, normalize, pow, select, length, dot, reflect, positionViewDirection } from 'three/tsl';
import { makeRNG, clamp, lerp, smoothstep as ss } from '../core/math.js';
import { U } from '../render/Uniforms.js';
import { proceduralBump } from '../render/ProcTex.js';
import { SURFACE } from './Track.js';

const _m = new Matrix4(), _q = new Quaternion(), _p = new Vector3(), _s = new Vector3(), _c = new Color(), _d = new Object3D();
const _up = new Vector3( 0, 1, 0 );

/* ============================================================================================ */
/* Geometry recipes                                                                             */
/* ============================================================================================ */

function colorize( geo, color ) {
	const n = geo.attributes.position.count;
	const arr = new Float32Array( n * 3 );
	for ( let i = 0; i < n; i ++ ) { arr[ i * 3 ] = color[ 0 ]; arr[ i * 3 + 1 ] = color[ 1 ]; arr[ i * 3 + 2 ] = color[ 2 ]; }
	geo.setAttribute( 'color', new Float32BufferAttribute( arr, 3 ) );
	return geo;
}
function displace( geo, amp, freq, seed ) {
	const pos = geo.attributes.position;
	for ( let i = 0; i < pos.count; i ++ ) {
		const x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
		const n = Math.sin( x * freq + seed ) * Math.cos( y * freq * 1.3 + seed * 2 ) * Math.sin( z * freq * 0.7 + seed * 3 );
		const l = Math.hypot( x, y, z ) || 1;
		const f = 1 + n * amp;
		pos.setXYZ( i, x * f, y * f, z * f );
	}
	pos.needsUpdate = true;
	geo.computeVertexNormals();
	return geo;
}

function pineGeometry( h = 9, rng ) {
	const parts = [];
	const trunk = new CylinderGeometry( 0.12, 0.3, h * 0.55, 7 ); trunk.translate( 0, h * 0.27, 0 );
	parts.push( colorize( trunk, [ 0.22, 0.14, 0.08 ] ) );
	const tiers = 3;
	for ( let i = 0; i < tiers; i ++ ) {
		const t = i / tiers;
		const r = lerp( 2.6, 1.2, t ) * h / 9, ch = h * 0.3;
		const cone = new ConeGeometry( r, ch, 8 ); cone.translate( 0, h * 0.35 + t * h * 0.55 + ch / 2, 0 );
		const g = 0.26 + rng() * 0.1;
		parts.push( colorize( cone, [ 0.05 + rng() * 0.03, g, 0.06 ] ) );
	}
	return mergeGeometries( parts );
}
function broadleafGeometry( h = 8, rng ) {
	const parts = [];
	const trunk = new CylinderGeometry( 0.16, 0.34, h * 0.5, 7 ); trunk.translate( 0, h * 0.25, 0 );
	parts.push( colorize( trunk, [ 0.26, 0.18, 0.1 ] ) );
	for ( let i = 0; i < 4; i ++ ) {
		const r = h * ( 0.22 + rng() * 0.12 );
		const blob = displace( new IcosahedronGeometry( r, 2 ), 0.18, 1.7, rng() * 10 );
		blob.translate( ( rng() - 0.5 ) * h * 0.35, h * 0.6 + ( rng() - 0.3 ) * h * 0.2, ( rng() - 0.5 ) * h * 0.35 );
		parts.push( colorize( blob, [ 0.08 + rng() * 0.08, 0.3 + rng() * 0.15, 0.05 ] ) );
	}
	return mergeGeometries( parts );
}
function palmGeometry( h = 9, rng ) {
	const parts = [];
	const segs = 6;
	let x = 0, y = 0;
	const lean = ( rng() - 0.5 ) * 0.5;
	for ( let i = 0; i < segs; i ++ ) {
		const seg = new CylinderGeometry( 0.17 - i * 0.015, 0.2 - i * 0.015, h / segs + 0.1, 7 );
		seg.translate( 0, ( h / segs ) / 2, 0 );
		seg.rotateZ( lean * ( i / segs ) );
		seg.translate( x, y, 0 );
		x += Math.sin( lean * i / segs ) * h / segs; y += Math.cos( lean * i / segs ) * h / segs;
		parts.push( colorize( seg, [ 0.36, 0.28, 0.18 ] ) );
	}
	for ( let i = 0; i < 9; i ++ ) {
		const frond = new BoxGeometry( 0.5, 0.05, 3.2, 1, 1, 4 );
		const pos = frond.attributes.position;
		for ( let k = 0; k < pos.count; k ++ ) { const z = pos.getZ( k ); pos.setY( k, pos.getY( k ) - ( z + 1.6 ) ** 2 * 0.12 ); pos.setX( k, pos.getX( k ) * ( 1 - ( z + 1.6 ) / 4 ) ); }
		frond.translate( 0, 0, 1.6 );
		frond.rotateX( - 0.4 - rng() * 0.3 );
		frond.rotateY( i / 9 * Math.PI * 2 );
		frond.translate( x, y, 0 );
		parts.push( colorize( frond, [ 0.1, 0.4 + rng() * 0.15, 0.08 ] ) );
	}
	return mergeGeometries( parts );
}
function cactusGeometry( h = 4, rng ) {
	const parts = [];
	const body = new CylinderGeometry( 0.32, 0.38, h, 9 ); body.translate( 0, h / 2, 0 );
	parts.push( colorize( body, [ 0.2, 0.36, 0.14 ] ) );
	const arms = 1 + Math.floor( rng() * 3 );
	for ( let i = 0; i < arms; i ++ ) {
		const side = i % 2 === 0 ? 1 : - 1;
		const ay = h * ( 0.35 + rng() * 0.3 );
		const a1 = new CylinderGeometry( 0.2, 0.22, 1.0, 8 ); a1.rotateZ( Math.PI / 2 ); a1.translate( side * 0.6, ay, 0 );
		const a2 = new CylinderGeometry( 0.2, 0.22, h * 0.4, 8 ); a2.translate( side * 1.0, ay + h * 0.2, 0 );
		parts.push( colorize( a1, [ 0.2, 0.36, 0.14 ] ), colorize( a2, [ 0.2, 0.36, 0.14 ] ) );
	}
	return mergeGeometries( parts );
}
function rockGeometry( r, rng ) {
	const g = displace( new IcosahedronGeometry( r, 2 ), 0.35, 1.2 + rng() * 1.5, rng() * 20 );
	g.scale( 1, 0.6 + rng() * 0.5, 1 );
	return g;
}
function mesaGeometry( rng ) {
	const r = 40 + rng() * 60, h = 30 + rng() * 40;
	const g = new CylinderGeometry( r * ( 0.7 + rng() * 0.2 ), r, h, 14, 4 );
	const pos = g.attributes.position;
	for ( let i = 0; i < pos.count; i ++ ) {
		const x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
		const a = Math.atan2( z, x );
		const n = 1 + 0.12 * Math.sin( a * 5 + y * 0.1 ) * Math.cos( a * 3 - y * 0.2 );
		pos.setX( i, x * n ); pos.setZ( i, z * n );
	}
	g.translate( 0, h / 2 - 6, 0 );
	g.computeVertexNormals();
	return g;
}
function grandstandGeometry( width = 40, rows = 10 ) {
	const parts = [];
	const depth = 0.9, rise = 0.5;
	for ( let i = 0; i < rows; i ++ ) {
		const step = new BoxGeometry( width, rise, depth );
		step.translate( 0, rise * i + rise / 2 + 1.0, - depth * i );
		parts.push( colorize( step, [ 0.35, 0.35, 0.38 ] ) );
	}
	const base = new BoxGeometry( width + 1, 1.0, rows * depth + 1 ); base.translate( 0, 0.5, - rows * depth / 2 + 0.5 );
	parts.push( colorize( base, [ 0.3, 0.3, 0.32 ] ) );
	const roof = new BoxGeometry( width + 2, 0.25, rows * depth + 2 ); roof.translate( 0, rise * rows + 4.5, - rows * depth / 2 + 0.5 );
	parts.push( colorize( roof, [ 0.9, 0.9, 0.92 ] ) );
	for ( const x of [ - width / 2, 0, width / 2 ] ) {
		const post = new CylinderGeometry( 0.15, 0.15, rise * rows + 4.5, 6 ); post.translate( x, ( rise * rows + 4.5 ) / 2, - rows * depth + 0.5 );
		parts.push( colorize( post, [ 0.6, 0.6, 0.62 ] ) );
	}
	return mergeGeometries( parts );
}
function lightTowerGeometry( h = 28 ) {
	const parts = [];
	const pole = new CylinderGeometry( 0.25, 0.5, h, 8 ); pole.translate( 0, h / 2, 0 );
	parts.push( colorize( pole, [ 0.55, 0.55, 0.58 ] ) );
	const head = new BoxGeometry( 4, 1.6, 0.5 ); head.translate( 0, h, 0 );
	parts.push( colorize( head, [ 0.2, 0.2, 0.22 ] ) );
	return mergeGeometries( parts );
}
function streetLampGeometry( h = 9 ) {
	const parts = [];
	const pole = new CylinderGeometry( 0.08, 0.14, h, 6 ); pole.translate( 0, h / 2, 0 );
	parts.push( colorize( pole, [ 0.3, 0.3, 0.32 ] ) );
	const arm = new BoxGeometry( 2.2, 0.1, 0.1 ); arm.translate( 1.0, h, 0 );
	parts.push( colorize( arm, [ 0.3, 0.3, 0.32 ] ) );
	return mergeGeometries( parts );
}

/* ============================================================================================ */
/* Materials                                                                                    */
/* ============================================================================================ */

function foliageMaterial( sway = 1 ) {
	const mat = new MeshStandardNodeMaterial();
	const col = attribute( 'color', 'vec3' );
	const n = mx_noise_float( positionWorld.mul( 0.8 ) ).mul( 0.5 ).add( 0.5 );
	mat.colorNode = col.mul( n.mul( 0.4 ).add( 0.8 ) ).mul( oneMinus( U.wetness.mul( 0.25 ) ) );
	mat.roughnessNode = float( 0.85 ).sub( U.wetness.mul( 0.3 ) );
	// wind: sway the top of the object in world space, phase by position
	const phase = positionWorld.x.mul( 0.15 ).add( positionWorld.z.mul( 0.11 ) );
	const gust = sin( time.mul( 1.3 ).add( phase ) ).mul( 0.5 ).add( sin( time.mul( 2.9 ).add( phase.mul( 2.0 ) ) ).mul( 0.25 ) );
	const amp = positionLocal.y.mul( positionLocal.y ).mul( 0.0045 * sway ).mul( U.rain.mul( 2.0 ).add( 1.0 ) );
	mat.positionNode = positionLocal.add( vec3( gust.mul( amp ), 0.0, gust.mul( amp ).mul( 0.6 ) ) );
	mat.vertexColors = true;
	mat.name = 'foliage';
	return mat;
}
function rockMaterial( tint ) {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const n = mx_fractal_noise_float( p.mul( 0.3 ), 3, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
	const strata = step( 0.7, fract( p.y.mul( 0.4 ).add( n ) ) ).mul( 0.15 );
	mat.colorNode = vec3( ...tint ).mul( n.mul( 0.5 ).add( 0.7 ) ).mul( oneMinus( strata ) ).mul( oneMinus( U.wetness.mul( 0.3 ) ) );
	mat.roughnessNode = float( 0.92 ).sub( U.wetness.mul( 0.35 ) );
	mat.normalNode = proceduralBump( mx_noise_float( p.mul( 2.5 ) ).mul( 0.3 ), 1.0 );
	mat.name = 'rock';
	return mat;
}
function structureMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = attribute( 'color', 'vec3' ).mul( mx_noise_float( positionWorld.mul( 1.5 ) ).mul( 0.15 ).add( 0.9 ) );
	mat.roughnessNode = float( 0.7 );
	mat.metalnessNode = float( 0.1 );
	mat.vertexColors = true;
	return mat;
}
function crowdMaterial() {
	const mat = new MeshStandardNodeMaterial();
	// random bright clothing per instance + a little bob so the crowd feels alive
	const h = hash( instanceIndex.toFloat().mul( 0.731 ) );
	const h2 = hash( instanceIndex.toFloat().mul( 1.37 ).add( 3.0 ) );
	mat.colorNode = vec3( h, h2, hash( instanceIndex.toFloat().add( 9.1 ) ) ).mul( 0.7 ).add( 0.15 );
	const bob = sin( time.mul( 6.0 ).add( h.mul( 40.0 ) ) ).mul( 0.5 ).add( 0.5 ).mul( step( 0.6, h2 ) ).mul( 0.25 );
	mat.positionNode = positionLocal.add( vec3( 0.0, bob, 0.0 ) );
	mat.roughnessNode = float( 0.9 );
	return mat;
}
function buildingMaterial( neon = false ) {
	const mat = new MeshStandardNodeMaterial();
	const p = positionWorld;
	const n = normalWorld;
	// windows: grid in world space on vertical faces; some lit at night (hash per window)
	const isWall = oneMinus( abs( n.y ) );
	const wx = p.x.mul( abs( n.z ) ).add( p.z.mul( abs( n.x ) ) ); // coordinate along the facade
	const cellX = floor( wx.div( 3.0 ) ), cellY = floor( p.y.div( 3.2 ) );
	const fx = fract( wx.div( 3.0 ) ), fy = fract( p.y.div( 3.2 ) );
	const win = step( 0.2, fx ).mul( step( fx, 0.8 ) ).mul( step( 0.25, fy ) ).mul( step( fy, 0.75 ) ).mul( isWall ).mul( step( 2.0, p.y ) );
	const seed = hash( cellX.add( cellY.mul( 131.0 ) ).add( floor( p.x.mul( 0.01 ) ).mul( 17.0 ) ) );
	const lit = step( 0.45, seed ).mul( win ).mul( U.night );
	const tint = attribute( 'color', 'vec3' );
	const base = tint.mul( mx_noise_float( p.mul( 0.5 ) ).mul( 0.2 ).add( 0.9 ) );
	const glassCol = vec3( 0.05, 0.08, 0.1 );
	mat.colorNode = mix( base, glassCol, win );
	const warm = vec3( 1.0, 0.85, 0.6 ), cool = vec3( 0.7, 0.85, 1.0 );
	let emissive = mix( warm, cool, step( 0.7, seed ) ).mul( lit ).mul( seed.mul( 2.0 ).add( 1.0 ) );
	if ( neon ) {
		// neon strips along the roof edge and at street level, hue per building
		const hueSeed = hash( floor( p.x.mul( 0.02 ) ).add( floor( p.z.mul( 0.02 ) ).mul( 7.0 ) ) );
		const neonCol = vec3( sin( hueSeed.mul( 6.28 ) ).mul( 0.5 ).add( 0.5 ), sin( hueSeed.mul( 6.28 ).add( 2.1 ) ).mul( 0.5 ).add( 0.5 ), sin( hueSeed.mul( 6.28 ).add( 4.2 ) ).mul( 0.5 ).add( 0.5 ) ).pow( 0.6 );
		const bandY = smoothstep( 0.35, 0.3, abs( fract( p.y.div( 12.0 ) ).sub( 0.5 ) ) ).mul( step( 0.9, fract( p.y.div( 12.0 ) ).add( 0.5 ) ) );
		const strip = step( 0.93, fract( p.y.div( 12.0 ) ) ).mul( isWall ).add( step( 0.5, fy ).mul( step( fy, 0.56 ) ).mul( step( 4.0, p.y ).mul( step( p.y, 7.0 ) ) ).mul( isWall ) );
		emissive = emissive.add( neonCol.mul( strip.mul( 6.0 ) ).mul( U.neon ) );
	}
	mat.emissiveNode = emissive;
	mat.roughnessNode = mix( float( 0.8 ), float( 0.15 ), win );
	mat.metalnessNode = win.mul( 0.4 );
	mat.vertexColors = true;
	mat.name = 'building';
	return mat;
}
function boardMaterial() {
	const mat = new MeshStandardNodeMaterial();
	// advertising boards: bold diagonal stripes & blocks in the instance colour
	const u = uv();
	const stripes = step( 0.5, fract( u.x.mul( 6.0 ).add( u.y.mul( 2.0 ) ) ) );
	const blocks = step( 0.75, fract( u.x.mul( 3.0 ) ) ).mul( step( 0.5, u.y ) );
	const n = normalWorld;
	const front = step( 0.5, abs( n.y ).oneMinus() );
	mat.colorNode = mix( vec3( 0.95 ), mix( vec3( 0.08 ), vec3( 0.95 ), stripes ), front ).mul( oneMinus( blocks.mul( 0.6 ) ) );
	mat.emissiveNode = mat.colorNode.mul( U.night.mul( 0.8 ) );
	mat.roughnessNode = float( 0.5 );
	return mat;
}
function lampHeadMaterial() {
	const mat = new MeshStandardNodeMaterial();
	mat.colorNode = vec3( 0.9 );
	mat.emissiveNode = vec3( 1.0, 0.9, 0.7 ).mul( U.night.mul( 25.0 ).add( 0.2 ) );
	return mat;
}
function tyreStackMaterial() {
	const mat = new MeshStandardNodeMaterial();
	const band = step( 0.5, fract( positionLocal.y.mul( 2.0 ).add( 0.25 ) ) );
	mat.colorNode = mix( vec3( 0.03 ), vec3( 0.03 ), band );
	mat.roughnessNode = float( 0.85 );
	return mat;
}
export function waterMaterial( deep = [ 0.01, 0.08, 0.14 ], shallow = [ 0.05, 0.3, 0.35 ] ) {
	const mat = new MeshPhysicalNodeMaterial();
	const p = positionWorld;
	const t = time;
	// layered animated waves → height field → bump normal
	const wave = Fn( ( [ pos ] ) => {
		const a = sin( pos.x.mul( 0.35 ).add( t.mul( 0.9 ) ) ).mul( 0.5 );
		const b = sin( pos.z.mul( 0.27 ).sub( t.mul( 0.7 ) ).add( pos.x.mul( 0.1 ) ) ).mul( 0.4 );
		const c = mx_noise_float( vec3( pos.x.mul( 0.08 ), pos.z.mul( 0.08 ), t.mul( 0.15 ) ) ).mul( 0.6 );
		const d = mx_noise_float( vec3( pos.x.mul( 0.5 ), pos.z.mul( 0.5 ), t.mul( 0.4 ) ) ).mul( 0.15 );
		return a.add( b ).add( c ).add( d );
	} );
	const h = wave( p );
	mat.normalNode = proceduralBump( h, 0.6 );
	const fres = pow( oneMinus( saturate( dot( normalWorld, positionViewDirection ) ) ), 3.0 );
	mat.colorNode = mix( vec3( ...deep ), vec3( ...shallow ), smoothstep( - 0.4, 0.6, h ).mul( 0.5 ) );
	mat.roughnessNode = float( 0.06 ).add( U.rain.mul( 0.15 ) );
	mat.metalnessNode = float( 0.0 );
	mat.clearcoatNode = float( 1 );
	mat.clearcoatRoughnessNode = float( 0.04 );
	mat.specularIntensityNode = float( 0.6 ).add( fres.mul( 0.4 ) );
	mat.name = 'water';
	return mat;
}

/* ============================================================================================ */
/* Scenery builder                                                                              */
/* ============================================================================================ */

export class Scenery {
	constructor( track, quality ) {
		this.track = track;
		this.quality = quality;
		this.group = new Group();
		this.group.name = 'scenery';
		this.rng = makeRNG( 1234 + track.def.id.length * 77 );
		this.density = quality.scenery ?? 1;
		this.lamps = []; // positions for pooled point lights (city / tunnel)
		this._proj = {};
		this.build();
	}

	/** Random position near the track that is not on the road. Returns null if rejected. */
	scatterPoint( minLat, maxLat, opts = {} ) {
		const rng = this.rng, t = this.track;
		const sm = t.samples[ Math.floor( rng() * t.samples.length ) ];
		const side = opts.side ?? ( rng() < 0.5 ? - 1 : 1 );
		const lat = side * ( minLat + rng() * ( maxLat - minLat ) ) + ( sm.width / 2 );
		_p.copy( sm.pos ).addScaledVector( sm.right, lat ).addScaledVector( sm.tangent, ( rng() - 0.5 ) * 4 );
		const p = t.project( _p.x, _p.z, sm.index, this._proj );
		if ( Math.abs( p.lateral ) < p.wallLateral + ( opts.clearance ?? 2 ) ) return null;
		const y = t.terrainHeight( _p.x, _p.z, p );
		if ( opts.aboveSea !== false && t.def.seaLevel !== undefined && y < t.def.seaLevel + 0.5 ) return null;
		return { x: _p.x, y, z: _p.z, sample: sm, side, lateral: p.lateral };
	}

	instanced( geo, material, items, { shadow = true, colors = false } = {} ) {
		if ( ! items.length ) return null;
		const im = new InstancedMesh( geo, material, items.length );
		items.forEach( ( it, i ) => {
			_d.position.set( it.x, it.y, it.z );
			_d.rotation.set( it.rx || 0, it.ry || 0, it.rz || 0 );
			_d.scale.setScalar( it.s || 1 );
			if ( it.sy ) _d.scale.y = it.sy;
			if ( it.sx ) _d.scale.x = it.sx;
			if ( it.sz ) _d.scale.z = it.sz;
			_d.updateMatrix();
			im.setMatrixAt( i, _d.matrix );
			if ( colors && it.color ) im.setColorAt( i, _c.setRGB( ...it.color ) );
		} );
		im.castShadow = shadow; im.receiveShadow = shadow;
		im.computeBoundingSphere();
		this.group.add( im );
		return im;
	}

	build() {
		const b = this.track.biome.scenery;
		this.buildCommon();
		if ( b === 'coastal' ) this.buildCoastal();
		else if ( b === 'mountain' ) this.buildMountain();
		else if ( b === 'desert' ) this.buildDesert();
		else if ( b === 'forest' ) this.buildForest();
		else if ( b === 'city' ) this.buildCity();
		else if ( b === 'oval' ) this.buildOval();
	}

	/* ---- shared track furniture ---------------------------------------------------------- */
	buildCommon() {
		const t = this.track, rng = this.rng;
		const S = t.samples, N = S.length;
		const isOval = t.biome.scenery === 'oval', isCity = t.biome.scenery === 'city';
		// grandstands: along the start straight on both sides, and at the outside of the first big corners
		const stands = [];
		const standMat = structureMaterial();
		const standGeo = grandstandGeometry( 44, 12 );
		const crowdItems = [];
		const placeStand = ( idx, side, width = 44 ) => {
			const sm = S[ ( idx + N ) % N ];
			const lat = sm.width / 2 + t.runoffWidth + ( isCity ? 6 : 10 );
			_p.copy( sm.pos ).addScaledVector( sm.right, side * lat );
			const y = t.terrainHeight( _p.x, _p.z );
			const ry = Math.atan2( sm.tangent.x, sm.tangent.z ) + ( side > 0 ? Math.PI / 2 : - Math.PI / 2 ) + Math.PI;
			stands.push( { x: _p.x, y, z: _p.z, ry } );
			// crowd: rows of little figures on the steps
			for ( let r = 0; r < 12; r ++ ) for ( let k = 0; k < width / 1.1; k ++ ) {
				if ( rng() < 0.35 ) continue;
				const lx = - width / 2 + k * 1.1 + rng() * 0.6, lz = - 0.9 * r - 0.2, ly = 1.0 + 0.5 * r + 0.55;
				const cx = Math.cos( ry ), sx = Math.sin( ry );
				crowdItems.push( { x: _p.x + lx * cx + lz * sx, y: y + ly, z: _p.z - lx * sx + lz * cx, s: 0.9 + rng() * 0.3, ry: rng() * 6.28 } );
			}
		};
		if ( ! isCity ) { placeStand( 20, - 1 ); placeStand( 20, 1 ); placeStand( 50, - 1 ); }
		else { placeStand( 24, 1 ); }
		if ( isOval ) {
			for ( let i = 60; i < N; i += 50 ) placeStand( i, 1 );
		} else {
			for ( const c of t.corners.slice( 0, 3 ) ) placeStand( c.from + 10, S[ ( c.from + 10 ) % N ].curvature > 0 ? 1 : - 1 );
		}
		this.instanced( standGeo, standMat, stands );
		const crowdGeo = new ConeGeometry( 0.25, 0.9, 5 ); crowdGeo.translate( 0, 0.45, 0 );
		this.instanced( crowdGeo, crowdMaterial(), crowdItems.slice( 0, Math.floor( crowdItems.length * Math.min( 1, this.density ) ) ), { shadow: false } );

		// advertising boards along the barriers near corners, marshal posts, tyre stacks, distance boards
		const boards = [], tyres = [], posts = [], markers = [];
		for ( const c of t.corners ) {
			const mid = S[ ( c.from + Math.floor( ( ( c.to - c.from + N ) % N ) / 2 ) ) % N ];
			const side = mid.curvature > 0 ? 1 : - 1; // outside of the corner (left turn → right side)
			for ( let k = 0; k < 6; k ++ ) {
				const sm = S[ ( c.from - 30 + k * 6 + N ) % N ];
				const lat = sm.width / 2 + ( sm.kerbR ? 1.4 : 0 ) + t.runoffWidth + 1.6;
				_p.copy( sm.pos ).addScaledVector( sm.right, side * lat );
				const y = t.terrainHeight( _p.x, _p.z );
				boards.push( { x: _p.x, y: y + 0.6, z: _p.z, ry: Math.atan2( sm.tangent.x, sm.tangent.z ), color: [ rng(), rng(), rng() ] } );
			}
			for ( let k = 0; k < 3; k ++ ) { // 150/100/50 m boards
				const sm = S[ ( c.from - ( 75 - k * 25 ) + N ) % N ];
				const lat = sm.width / 2 + 1.4 + t.runoffWidth + 0.9;
				_p.copy( sm.pos ).addScaledVector( sm.right, - side * lat );
				markers.push( { x: _p.x, y: t.terrainHeight( _p.x, _p.z ), z: _p.z, ry: Math.atan2( sm.tangent.x, sm.tangent.z ), k } );
			}
			// tyre stacks at the apex outside
			const apex = S[ ( c.from + Math.floor( ( ( c.to - c.from + N ) % N ) / 2 ) ) % N ];
			for ( let k = 0; k < 4; k ++ ) {
				_p.copy( apex.pos ).addScaledVector( apex.right, side * ( apex.width / 2 + 1.4 + t.runoffWidth + 1.2 ) ).addScaledVector( apex.tangent, k * 1.4 - 2 );
				tyres.push( { x: _p.x, y: t.terrainHeight( _p.x, _p.z ), z: _p.z } );
			}
			const mp = S[ ( c.from - 8 + N ) % N ];
			_p.copy( mp.pos ).addScaledVector( mp.right, - side * ( mp.width / 2 + 1.4 + t.runoffWidth + 3 ) );
			posts.push( { x: _p.x, y: t.terrainHeight( _p.x, _p.z ), z: _p.z, ry: Math.atan2( mp.tangent.x, mp.tangent.z ) } );
		}
		this.instanced( new BoxGeometry( 8, 1.2, 0.15 ), boardMaterial(), boards, { colors: true } );
		const tyreGeo = mergeGeometries( [ 0, 1, 2 ].map( ( i ) => { const g = new TorusGeometry( 0.45, 0.17, 6, 14 ); g.rotateX( Math.PI / 2 ); g.translate( 0, 0.17 + i * 0.34, 0 ); return g; } ) );
		this.instanced( tyreGeo, tyreStackMaterial(), tyres );
		const hutGeo = mergeGeometries( [ colorize( new BoxGeometry( 2.4, 2.4, 2.0 ).translate( 0, 1.2, 0 ), [ 0.9, 0.9, 0.9 ] ), colorize( new BoxGeometry( 2.8, 0.2, 2.4 ).translate( 0, 2.5, 0 ), [ 0.8, 0.1, 0.1 ] ) ] );
		this.instanced( hutGeo, structureMaterial(), posts );
		const markerMat = new MeshStandardNodeMaterial();
		const mu = uv();
		const band = step( 0.33, mu.y ).mul( step( mu.y, 0.66 ) );
		markerMat.colorNode = mix( vec3( 0.9, 0.9, 0.9 ), vec3( 0.05, 0.3, 0.9 ), band );
		markerMat.emissiveNode = markerMat.colorNode.mul( U.night.mul( 0.5 ) );
		const markerGeo = mergeGeometries( [ new BoxGeometry( 1.2, 1.2, 0.08 ).translate( 0, 1.8, 0 ), new BoxGeometry( 0.08, 1.4, 0.08 ).translate( 0, 0.7, 0 ) ] );
		this.instanced( markerGeo, markerMat, markers, { shadow: false } );
		// tunnel portal lamps register for the light pool
		if ( t.lamps ) for ( const l of t.lamps ) this.lamps.push( { pos: l.p.clone().addScaledVector( l.up, - 0.4 ), color: [ 1.0, 0.95, 0.8 ], intensity: 60, range: 18 } );
	}

	/* ---- biomes -------------------------------------------------------------------------- */
	buildCoastal() {
		const t = this.track, rng = this.rng;
		// sea
		const sea = new Mesh( new PlaneGeometry( 6000, 6000, 1, 1 ), waterMaterial() );
		sea.rotation.x = - Math.PI / 2;
		sea.position.set( t.bounds.cx, t.def.seaLevel ?? - 4, t.bounds.cz );
		sea.receiveShadow = true; sea.name = 'sea';
		this.group.add( sea );
		// palms close to the road, broadleaf further
		const palms = [], trees = [], rocks = [], houses = [];
		const nPalm = Math.floor( 260 * this.density ), nTree = Math.floor( 300 * this.density ), nRock = Math.floor( 140 * this.density );
		for ( let i = 0; i < nPalm; i ++ ) { const p = this.scatterPoint( 6, 40 ); if ( p ) palms.push( { ...p, ry: rng() * 6.28, s: 0.8 + rng() * 0.5 } ); }
		for ( let i = 0; i < nTree; i ++ ) { const p = this.scatterPoint( 20, 160 ); if ( p ) trees.push( { ...p, ry: rng() * 6.28, s: 0.7 + rng() * 0.6 } ); }
		for ( let i = 0; i < nRock; i ++ ) { const p = this.scatterPoint( 10, 200, { aboveSea: false } ); if ( p ) rocks.push( { ...p, y: Math.max( p.y, ( t.def.seaLevel ?? - 4 ) - 1 ), ry: rng() * 6.28, s: 1 + rng() * 3 } ); }
		for ( let i = 0; i < Math.floor( 40 * this.density ); i ++ ) { const p = this.scatterPoint( 25, 120 ); if ( p ) houses.push( { ...p, ry: Math.round( rng() * 4 ) * Math.PI / 2, sx: 6 + rng() * 6, sy: 3.5 + rng() * 3, sz: 6 + rng() * 6, color: [ 0.9, 0.85 + rng() * 0.1, 0.75 + rng() * 0.2 ] } ); }
		this.instanced( palmGeometry( 9, rng ), foliageMaterial( 1.4 ), palms );
		this.instanced( broadleafGeometry( 8, rng ), foliageMaterial( 0.8 ), trees );
		this.instanced( rockGeometry( 1.2, rng ), rockMaterial( [ 0.5, 0.48, 0.44 ] ), rocks );
		this.instanced( colorize( new BoxGeometry( 1, 1, 1 ).translate( 0, 0.5, 0 ), [ 1, 1, 1 ] ), buildingMaterial( false ), houses, { colors: true } );
		// lighthouse near the hairpin
		const c = t.corners[ 2 ] || t.corners[ 0 ];
		const sm = t.samples[ ( c.from + 20 ) % t.samples.length ];
		_p.copy( sm.pos ).addScaledVector( sm.right, ( sm.curvature > 0 ? - 1 : 1 ) * 45 );
		const lhY = t.terrainHeight( _p.x, _p.z );
		const lhMat = structureMaterial();
		const lh = new Mesh( mergeGeometries( [ colorize( new CylinderGeometry( 2.2, 3.0, 22, 12 ).translate( 0, 11, 0 ), [ 0.92, 0.92, 0.9 ] ), colorize( new CylinderGeometry( 2.6, 2.6, 3, 12 ).translate( 0, 23.5, 0 ), [ 0.7, 0.1, 0.1 ] ), colorize( new CylinderGeometry( 0.2, 2.8, 2.5, 12 ).translate( 0, 26, 0 ), [ 0.2, 0.2, 0.2 ] ) ] ), lhMat );
		lh.position.set( _p.x, lhY, _p.z ); lh.castShadow = true; this.group.add( lh );
		const beacon = new Mesh( new SphereGeometry( 1.2, 12, 8 ), lampHeadMaterial() ); beacon.position.set( _p.x, lhY + 23.5, _p.z ); this.group.add( beacon );
		this.lamps.push( { pos: beacon.position.clone(), color: [ 1, 0.95, 0.8 ], intensity: 400, range: 120 } );
	}

	buildMountain() {
		const rng = this.rng;
		const pines = [], rocks = [], chalets = [];
		for ( let i = 0; i < Math.floor( 1400 * this.density ); i ++ ) { const p = this.scatterPoint( 5, 220 ); if ( p && p.y < 150 ) pines.push( { ...p, ry: rng() * 6.28, s: 0.6 + rng() * 0.9 } ); }
		for ( let i = 0; i < Math.floor( 260 * this.density ); i ++ ) { const p = this.scatterPoint( 6, 260 ); if ( p ) rocks.push( { ...p, ry: rng() * 6.28, s: 1 + rng() * 4 } ); }
		for ( let i = 0; i < Math.floor( 24 * this.density ); i ++ ) { const p = this.scatterPoint( 25, 110 ); if ( p ) chalets.push( { ...p, ry: rng() * 6.28, sx: 7 + rng() * 4, sy: 4 + rng() * 2, sz: 9 + rng() * 5, color: [ 0.45, 0.3, 0.18 ] } ); }
		this.instanced( pineGeometry( 11, rng ), foliageMaterial( 0.6 ), pines );
		this.instanced( rockGeometry( 1.5, rng ), rockMaterial( [ 0.42, 0.4, 0.4 ] ), rocks );
		this.instanced( colorize( new BoxGeometry( 1, 1, 1 ).translate( 0, 0.5, 0 ), [ 1, 1, 1 ] ), buildingMaterial( false ), chalets, { colors: true } );
	}

	buildDesert() {
		const rng = this.rng;
		const cacti = [], rocks = [], mesas = [], shrubs = [];
		for ( let i = 0; i < Math.floor( 500 * this.density ); i ++ ) { const p = this.scatterPoint( 6, 200 ); if ( p ) cacti.push( { ...p, ry: rng() * 6.28, s: 0.6 + rng() * 1.0 } ); }
		for ( let i = 0; i < Math.floor( 400 * this.density ); i ++ ) { const p = this.scatterPoint( 5, 250 ); if ( p ) rocks.push( { ...p, ry: rng() * 6.28, s: 0.5 + rng() * 2.5 } ); }
		for ( let i = 0; i < Math.floor( 900 * this.density ); i ++ ) { const p = this.scatterPoint( 4, 220 ); if ( p ) shrubs.push( { ...p, ry: rng() * 6.28, s: 0.5 + rng() * 0.6 } ); }
		for ( let i = 0; i < 14; i ++ ) { const p = this.scatterPoint( 260, 700, { clearance: 120 } ); if ( p ) mesas.push( { ...p, ry: rng() * 6.28, s: 0.8 + rng() * 1.2 } ); }
		this.instanced( cactusGeometry( 4, rng ), foliageMaterial( 0.1 ), cacti );
		this.instanced( rockGeometry( 1.2, rng ), rockMaterial( [ 0.62, 0.42, 0.28 ] ), rocks );
		const shrub = displace( new IcosahedronGeometry( 0.9, 1 ), 0.3, 3, 2 ); shrub.scale( 1, 0.6, 1 ); shrub.translate( 0, 0.4, 0 );
		this.instanced( colorize( shrub, [ 0.35, 0.33, 0.18 ] ), foliageMaterial( 0.3 ), shrubs, { shadow: false } );
		this.instanced( mesaGeometry( rng ), rockMaterial( [ 0.7, 0.38, 0.22 ] ), mesas );
	}

	buildForest() {
		const rng = this.rng;
		const pines = [], broad = [], rocks = [], ferns = [];
		for ( let i = 0; i < Math.floor( 1600 * this.density ); i ++ ) { const p = this.scatterPoint( 4, 180 ); if ( p ) ( rng() < 0.5 ? pines : broad ).push( { ...p, ry: rng() * 6.28, s: 0.7 + rng() * 0.9 } ); }
		for ( let i = 0; i < Math.floor( 120 * this.density ); i ++ ) { const p = this.scatterPoint( 5, 120 ); if ( p ) rocks.push( { ...p, ry: rng() * 6.28, s: 0.8 + rng() * 2 } ); }
		for ( let i = 0; i < Math.floor( 1200 * this.density ); i ++ ) { const p = this.scatterPoint( 2.5, 60 ); if ( p ) ferns.push( { ...p, ry: rng() * 6.28, s: 0.6 + rng() * 0.8 } ); }
		this.instanced( pineGeometry( 13, rng ), foliageMaterial( 0.7 ), pines );
		this.instanced( broadleafGeometry( 10, rng ), foliageMaterial( 0.9 ), broad );
		this.instanced( rockGeometry( 1.2, rng ), rockMaterial( [ 0.32, 0.33, 0.3 ] ), rocks );
		const fern = mergeGeometries( [ 0, 1, 2, 3, 4 ].map( ( i ) => { const g = new BoxGeometry( 0.25, 0.04, 1.3 ); g.translate( 0, 0.3, 0.6 ); g.rotateX( - 0.5 ); g.rotateY( i * 1.256 ); return g; } ) );
		this.instanced( colorize( fern, [ 0.08, 0.3, 0.08 ] ), foliageMaterial( 2.5 ), ferns, { shadow: false } );
	}

	buildCity() {
		const t = this.track, rng = this.rng;
		const buildings = [], lamps = [], towers = [];
		// city blocks: boxes hugging the circuit, taller further away, plus a skyline ring
		for ( let i = 0; i < Math.floor( 420 * this.density ); i ++ ) {
			const p = this.scatterPoint( 9, 140, { clearance: 6 } );
			if ( ! p ) continue;
			const far = ss( 10, 120, Math.abs( p.lateral ) );
			const h = 10 + rng() * 22 + far * ( 20 + rng() * 60 );
			const w = 12 + rng() * 16;
			buildings.push( { ...p, y: p.y - 1, ry: Math.atan2( p.sample.tangent.x, p.sample.tangent.z ), sx: w, sy: h, sz: 12 + rng() * 20, color: [ 0.35 + rng() * 0.3, 0.35 + rng() * 0.3, 0.4 + rng() * 0.3 ] } );
		}
		for ( let i = 0; i < 70; i ++ ) {
			const a = rng() * 6.28, r = 700 + rng() * 500;
			towers.push( { x: t.bounds.cx + Math.cos( a ) * r, y: - 2, z: t.bounds.cz + Math.sin( a ) * r, ry: rng() * 6.28, sx: 30 + rng() * 40, sy: 80 + rng() * 160, sz: 30 + rng() * 40, color: [ 0.2, 0.22, 0.3 ] } );
		}
		const box = colorize( new BoxGeometry( 1, 1, 1 ).translate( 0, 0.5, 0 ), [ 1, 1, 1 ] );
		this.instanced( box, buildingMaterial( true ), buildings, { colors: true } );
		this.instanced( box, buildingMaterial( true ), towers, { colors: true, shadow: false } );
		// street lamps along both sides, registered for pooled point lights
		const S = t.samples, N = S.length;
		for ( let i = 0; i < N; i += 18 ) {
			const sm = S[ i ];
			if ( sm.tunnel ) continue;
			const side = ( i / 18 ) % 2 === 0 ? 1 : - 1;
			const lat = sm.width / 2 + t.runoffWidth + 1.0;
			_p.copy( sm.pos ).addScaledVector( sm.right, side * lat );
			const ry = Math.atan2( sm.tangent.x, sm.tangent.z ) + ( side > 0 ? Math.PI / 2 : - Math.PI / 2 );
			lamps.push( { x: _p.x, y: t.terrainHeight( _p.x, _p.z ), z: _p.z, ry } );
			const head = _p.clone(); head.y += 9; head.addScaledVector( sm.right, - side * 1.8 );
			this.lamps.push( { pos: head, color: [ 1.0, 0.85, 0.6 ], intensity: 90, range: 26 } );
		}
		this.instanced( streetLampGeometry( 9 ), structureMaterial(), lamps );
		const heads = lamps.map( ( l ) => ( { x: l.x + Math.cos( l.ry ) * 1.8, y: l.y + 9, z: l.z - Math.sin( l.ry ) * 1.8 } ) );
		this.instanced( new BoxGeometry( 0.6, 0.2, 0.3 ), lampHeadMaterial(), heads, { shadow: false } );
		// harbour water on the outer side of the start straight
		const sea = new Mesh( new PlaneGeometry( 3000, 3000 ), waterMaterial( [ 0.01, 0.03, 0.06 ], [ 0.03, 0.08, 0.12 ] ) );
		sea.rotation.x = - Math.PI / 2; sea.position.set( t.bounds.cx, - 3.5, t.bounds.cz ); sea.name = 'sea';
		this.group.add( sea );
	}

	buildOval() {
		const t = this.track, rng = this.rng;
		const S = t.samples, N = S.length;
		const towers = [], heads = [], trees = [], trucks = [];
		for ( let i = 0; i < N; i += Math.floor( N / 10 ) ) {
			const sm = S[ i ];
			_p.copy( sm.pos ).addScaledVector( sm.right, sm.width / 2 + t.runoffWidth + 26 );
			const y = t.terrainHeight( _p.x, _p.z );
			towers.push( { x: _p.x, y, z: _p.z, ry: Math.atan2( sm.tangent.x, sm.tangent.z ) } );
			heads.push( { x: _p.x, y: y + 28, z: _p.z, ry: Math.atan2( sm.tangent.x, sm.tangent.z ) } );
			this.lamps.push( { pos: new Vector3( _p.x, y + 27, _p.z ), color: [ 1, 0.97, 0.9 ], intensity: 2500, range: 160 } );
		}
		this.instanced( lightTowerGeometry( 28 ), structureMaterial(), towers );
		this.instanced( new BoxGeometry( 4.2, 1.8, 0.4 ), lampHeadMaterial(), heads, { shadow: false } );
		for ( let i = 0; i < Math.floor( 200 * this.density ); i ++ ) { const p = this.scatterPoint( 60, 260, { side: 1 } ); if ( p ) trees.push( { ...p, ry: rng() * 6.28, s: 0.7 + rng() * 0.6 } ); }
		this.instanced( broadleafGeometry( 8, rng ), foliageMaterial( 0.8 ), trees );
		// infield: team trucks & garages
		for ( let i = 0; i < 30; i ++ ) { const p = this.scatterPoint( 35, 140, { side: - 1 } ); if ( p ) trucks.push( { ...p, ry: Math.round( rng() * 2 ) * Math.PI / 2, sx: 3, sy: 4, sz: 14, color: [ 0.8 + rng() * 0.2, 0.8 + rng() * 0.2, 0.85 ] } ); }
		this.instanced( colorize( new BoxGeometry( 1, 1, 1 ).translate( 0, 0.5, 0 ), [ 1, 1, 1 ] ), buildingMaterial( false ), trucks, { colors: true } );
	}
}
