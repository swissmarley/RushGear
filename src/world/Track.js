/**
 * Track — turns a TrackData definition into:
 *   • dense spline samples with Frenet frames (elevation, banking, width, curvature)
 *   • an analytic ground model (height / normal / surface / lateral offset at any XZ)
 *     used by the physics (no mesh raycasts) and by the terrain generator
 *   • meshes: asphalt, kerbs, runoff, barriers, tunnels, terrain, start gantry
 */
import { Group, Mesh, Vector3, InstancedMesh, Matrix4, BoxGeometry, Object3D, Quaternion } from 'three/webgpu';
import { GeometryBuilder } from './GeometryBuilder.js';
import { clamp, lerp, smoothstep, fbm2, ridged2, hash2 } from '../core/math.js';
import { BIOMES } from './Biomes.js';

const SAMPLE_SPACING = 2.0;   // metres between spline samples
const KERB_WIDTH = 1.4;
const CELL = 10;              // spatial hash cell size (m)

export const SURFACE = { ASPHALT: 0, KERB: 1, GRASS: 2, GRAVEL: 3, SAND: 4, CONCRETE: 5 };
const RUNOFF_SURFACE = { grass: SURFACE.GRASS, gravel: SURFACE.GRAVEL, sand: SURFACE.SAND, concrete: SURFACE.CONCRETE };

const _v = new Vector3(), _v2 = new Vector3(), _up = new Vector3( 0, 1, 0 );

/* --------------------------------------------------------------------------------------------- */
/* Catmull-Rom helpers over 5-component control points                                           */
/* --------------------------------------------------------------------------------------------- */

function catmullRom( p0, p1, p2, p3, t, out ) {
	const t2 = t * t, t3 = t2 * t;
	for ( let i = 0; i < 5; i ++ ) {
		out[ i ] = 0.5 * ( ( 2 * p1[ i ] ) + ( - p0[ i ] + p2[ i ] ) * t + ( 2 * p0[ i ] - 5 * p1[ i ] + 4 * p2[ i ] - p3[ i ] ) * t2 + ( - p0[ i ] + 3 * p1[ i ] - 3 * p2[ i ] + p3[ i ] ) * t3 );
	}
	return out;
}

export class Track {
	constructor( def ) {
		this.def = def;
		this.biome = BIOMES[ def.biome ];
		this.name = def.name;
		this.runoffWidth = def.runoffWidth ?? 6;
		this.runoffSurface = RUNOFF_SURFACE[ def.runoff ] ?? SURFACE.GRASS;
		this.group = new Group();
		this.group.name = 'track';
		this._buildSamples();
		this._buildFlags();
		this._buildHash();
		this.length = this.samples[ this.samples.length - 1 ].s + SAMPLE_SPACING;
		this.sectors = [ this.length / 3, this.length * 2 / 3 ];
		this.bounds = this._computeBounds();
		this.meanHeight = this.samples.reduce( ( a, s ) => a + s.pos.y, 0 ) / this.samples.length;
	}

	/* ------------------------------------------------------------------------------------------ */
	/* Samples                                                                                    */
	/* ------------------------------------------------------------------------------------------ */

	_buildSamples() {
		const pts = this.def.points.map( ( p ) => [ p[ 0 ], p[ 2 ] ?? 0, p[ 1 ], ( p[ 3 ] ?? 0 ) * Math.PI / 180, p[ 4 ] ?? 13 ] ); // x, y, z, bank, width
		const n = pts.length;
		// 1) dense parametric sampling
		const dense = [];
		const tmp = [ 0, 0, 0, 0, 0 ];
		const SUB = 48;
		for ( let i = 0; i < n; i ++ ) {
			const p0 = pts[ ( i - 1 + n ) % n ], p1 = pts[ i ], p2 = pts[ ( i + 1 ) % n ], p3 = pts[ ( i + 2 ) % n ];
			for ( let j = 0; j < SUB; j ++ ) {
				catmullRom( p0, p1, p2, p3, j / SUB, tmp );
				dense.push( { x: tmp[ 0 ], y: tmp[ 1 ], z: tmp[ 2 ], bank: tmp[ 3 ], w: tmp[ 4 ], seg: i + j / SUB } );
			}
		}
		// 2) cumulative length and even resampling
		let total = 0;
		const cum = [ 0 ];
		for ( let i = 1; i <= dense.length; i ++ ) {
			const a = dense[ i - 1 ], b = dense[ i % dense.length ];
			total += Math.hypot( b.x - a.x, b.y - a.y, b.z - a.z );
			cum.push( total );
		}
		const count = Math.floor( total / SAMPLE_SPACING );
		const samples = [];
		let k = 0;
		for ( let i = 0; i < count; i ++ ) {
			const s = i * ( total / count );
			while ( k < dense.length - 1 && cum[ k + 1 ] < s ) k ++;
			const a = dense[ k ], b = dense[ ( k + 1 ) % dense.length ];
			const t = ( s - cum[ k ] ) / Math.max( 1e-6, cum[ k + 1 ] - cum[ k ] );
			samples.push( {
				index: i, s,
				pos: new Vector3( lerp( a.x, b.x, t ), lerp( a.y, b.y, t ), lerp( a.z, b.z, t ) ),
				bankIn: lerp( a.bank, b.bank, t ), width: lerp( a.w, b.w, t ), seg: lerp( a.seg, b.seg, t ),
				tangent: new Vector3(), right: new Vector3(), up: new Vector3(), curvature: 0, bank: 0,
				tunnel: false, kerbL: false, kerbR: false, corner: - 1
			} );
		}
		// 3) tangents, curvature
		const N = samples.length;
		for ( let i = 0; i < N; i ++ ) {
			const p = samples[ ( i - 1 + N ) % N ].pos, q = samples[ ( i + 1 ) % N ].pos;
			samples[ i ].tangent.subVectors( q, p ).normalize();
		}
		const rawCurv = new Float32Array( N );
		for ( let i = 0; i < N; i ++ ) {
			const t0 = samples[ ( i - 1 + N ) % N ].tangent, t1 = samples[ ( i + 1 ) % N ].tangent;
			const a0 = Math.atan2( t0.x, t0.z ), a1 = Math.atan2( t1.x, t1.z );
			let d = a1 - a0; if ( d > Math.PI ) d -= 2 * Math.PI; if ( d < - Math.PI ) d += 2 * Math.PI;
			rawCurv[ i ] = d / ( 2 * SAMPLE_SPACING ); // signed; >0 = turning left (toward +x when heading +z)
		}
		// smooth curvature (box, ±6 samples) — the raw estimate is noisy
		for ( let i = 0; i < N; i ++ ) {
			let sum = 0;
			for ( let j = - 6; j <= 6; j ++ ) sum += rawCurv[ ( i + j + N ) % N ];
			samples[ i ].curvature = sum / 13;
		}
		// 4) banking = designer bank + automatic bank from curvature (smoothed over ±20 samples)
		const autoBank = this.def.autoBank ?? 0;
		const bankRaw = new Float32Array( N );
		for ( let i = 0; i < N; i ++ ) bankRaw[ i ] = samples[ i ].bankIn + clamp( samples[ i ].curvature * 14 * autoBank, - 0.12, 0.12 );
		for ( let i = 0; i < N; i ++ ) {
			let sum = 0;
			for ( let j = - 20; j <= 20; j ++ ) sum += bankRaw[ ( i + j + N ) % N ];
			samples[ i ].bank = sum / 41;
		}
		// 5) frames: right/up rotated around the tangent by the bank angle (inside of a corner drops)
		for ( const sm of samples ) {
			_v.crossVectors( sm.tangent, _up ).normalize();          // flat right (+x when heading -z... depends on handedness)
			_v2.crossVectors( _v, sm.tangent ).normalize();           // flat up
			const b = sm.bank;
			// positive curvature (left turn) → left side lower → right side higher → rotate so right.y > 0
			sm.right.copy( _v ).multiplyScalar( Math.cos( b ) ).addScaledVector( _v2, Math.sin( b ) );
			sm.up.copy( _v2 ).multiplyScalar( Math.cos( b ) ).addScaledVector( _v, - Math.sin( b ) );
		}
		this.samples = samples;
	}

	/** Corner names, kerbs, tunnels from control-point index ranges. */
	_buildFlags() {
		const S = this.samples, N = S.length;
		const segToIndex = ( seg ) => {
			// first sample whose seg >= seg
			for ( let i = 0; i < N; i ++ ) if ( S[ i ].seg >= seg ) return i;
			return N - 1;
		};
		this.corners = ( this.def.corners || [] ).map( ( c, id ) => {
			const from = segToIndex( c.from ), to = segToIndex( c.to );
			for ( let i = from; i !== to; i = ( i + 1 ) % N ) S[ i ].corner = id;
			return { id, name: c.name, from, to, s: S[ from ].s, sEnd: S[ to ].s };
		} );
		this.tunnels = ( this.def.tunnels || [] ).map( ( t ) => {
			const from = segToIndex( t.from ), to = segToIndex( t.to );
			for ( let i = from; i !== to; i = ( i + 1 ) % N ) S[ i ].tunnel = true;
			return { from, to };
		} );
		// kerbs where the road is tight enough (radius < 220 m), padded by 10 samples
		const tight = S.map( ( s ) => Math.abs( s.curvature ) > 1 / 220 );
		for ( let i = 0; i < N; i ++ ) {
			let any = false;
			for ( let j = - 10; j <= 10 && ! any; j ++ ) any = tight[ ( i + j + N ) % N ];
			if ( any && ! S[ i ].tunnel ) { S[ i ].kerbL = true; S[ i ].kerbR = true; }
		}
	}

	_buildHash() {
		this.hash = new Map();
		for ( const s of this.samples ) {
			const key = `${Math.floor( s.pos.x / CELL )},${Math.floor( s.pos.z / CELL )}`;
			if ( ! this.hash.has( key ) ) this.hash.set( key, [] );
			this.hash.get( key ).push( s.index );
		}
		this.coarse = this.samples.filter( ( s, i ) => i % 12 === 0 );
	}

	_computeBounds() {
		let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity, minY = Infinity, maxY = - Infinity;
		for ( const s of this.samples ) {
			minX = Math.min( minX, s.pos.x ); maxX = Math.max( maxX, s.pos.x );
			minZ = Math.min( minZ, s.pos.z ); maxZ = Math.max( maxZ, s.pos.z );
			minY = Math.min( minY, s.pos.y ); maxY = Math.max( maxY, s.pos.y );
		}
		return { minX, maxX, minZ, maxZ, minY, maxY, cx: ( minX + maxX ) / 2, cz: ( minZ + maxZ ) / 2 };
	}

	/* ------------------------------------------------------------------------------------------ */
	/* Queries                                                                                    */
	/* ------------------------------------------------------------------------------------------ */

	sampleAt( s ) {
		const L = this.length;
		s = ( ( s % L ) + L ) % L;
		return this.samples[ Math.min( this.samples.length - 1, Math.floor( s / SAMPLE_SPACING ) ) ];
	}

	nearestIndex( x, z, hint = - 1 ) {
		const S = this.samples, N = S.length;
		let best = - 1, bestD = Infinity;
		if ( hint >= 0 ) {
			for ( let j = - 4; j <= 4; j ++ ) {
				const i = ( hint + j + N ) % N;
				const d = ( S[ i ].pos.x - x ) ** 2 + ( S[ i ].pos.z - z ) ** 2;
				if ( d < bestD ) { bestD = d; best = i; }
			}
			if ( bestD < 36 ) return best; // within 6 m of a sample → trust the hint
		}
		const cx = Math.floor( x / CELL ), cz = Math.floor( z / CELL );
		for ( let r = 1; r <= 4; r ++ ) {
			for ( let dx = - r; dx <= r; dx ++ ) for ( let dz = - r; dz <= r; dz ++ ) {
				const list = this.hash.get( `${cx + dx},${cz + dz}` );
				if ( ! list ) continue;
				for ( const i of list ) {
					const d = ( S[ i ].pos.x - x ) ** 2 + ( S[ i ].pos.z - z ) ** 2;
					if ( d < bestD ) { bestD = d; best = i; }
				}
			}
			if ( best >= 0 && bestD < ( r * CELL ) ** 2 ) return best;
		}
		if ( best >= 0 ) return best;
		for ( const s of this.coarse ) {
			const d = ( s.pos.x - x ) ** 2 + ( s.pos.z - z ) ** 2;
			if ( d < bestD ) { bestD = d; best = s.index; }
		}
		return best;
	}

	/**
	 * Project a world XZ onto the track. Returns an object describing the road at that point.
	 * `out` is reused to avoid allocation in the physics loop.
	 */
	project( x, z, hint = - 1, out = {} ) {
		const S = this.samples, N = S.length;
		const i = this.nearestIndex( x, z, hint );
		// choose between segment (i-1,i) and (i,i+1)
		let bestT = 0, bestA = i, bestB = ( i + 1 ) % N, bestLat2 = Infinity;
		for ( const [ a, b ] of [ [ i, ( i + 1 ) % N ], [ ( i - 1 + N ) % N, i ] ] ) {
			const ax = S[ a ].pos.x, az = S[ a ].pos.z, bx = S[ b ].pos.x, bz = S[ b ].pos.z;
			const dx = bx - ax, dz = bz - az;
			const l2 = dx * dx + dz * dz || 1e-6;
			const t = clamp( ( ( x - ax ) * dx + ( z - az ) * dz ) / l2, 0, 1 );
			const px = ax + dx * t, pz = az + dz * t;
			const d2 = ( x - px ) ** 2 + ( z - pz ) ** 2;
			if ( d2 < bestLat2 ) { bestLat2 = d2; bestT = t; bestA = a; bestB = b; }
		}
		const A = S[ bestA ], B = S[ bestB ], t = bestT;
		const cx = lerp( A.pos.x, B.pos.x, t ), cy = lerp( A.pos.y, B.pos.y, t ), cz = lerp( A.pos.z, B.pos.z, t );
		const rx = lerp( A.right.x, B.right.x, t ), ry = lerp( A.right.y, B.right.y, t ), rz = lerp( A.right.z, B.right.z, t );
		const lat = ( ( x - cx ) * rx + ( z - cz ) * rz ) / ( rx * rx + rz * rz );
		const width = lerp( A.width, B.width, t );
		out.index = bestA;
		out.s = A.s + t * SAMPLE_SPACING;
		out.lateral = lat;
		out.width = width;
		out.curvature = lerp( A.curvature, B.curvature, t );
		out.tunnel = A.tunnel;
		out.corner = A.corner;
		out.tx = lerp( A.tangent.x, B.tangent.x, t ); out.ty = lerp( A.tangent.y, B.tangent.y, t ); out.tz = lerp( A.tangent.z, B.tangent.z, t );
		out.nx = lerp( A.up.x, B.up.x, t ); out.ny = lerp( A.up.y, B.up.y, t ); out.nz = lerp( A.up.z, B.up.z, t );
		out.rx = rx; out.ry = ry; out.rz = rz;
		out.cx = cx; out.cy = cy; out.cz = cz;
		// surface classification
		const half = width / 2, al = Math.abs( lat );
		const kerb = lat < 0 ? A.kerbL : A.kerbR;
		const kerbEdge = half + ( kerb ? KERB_WIDTH : 0 );
		const runoffEdge = kerbEdge + ( A.tunnel ? 0.6 : this.runoffWidth );
		out.wallLateral = runoffEdge + 0.4;
		let h = cy + lat * ry;
		if ( al <= half ) {
			out.surface = SURFACE.ASPHALT;
			h += 0.02 * ( 1 - ( al / half ) ** 2 ); // slight crown
		} else if ( al <= kerbEdge ) {
			out.surface = SURFACE.KERB;
			const f = ( al - half ) / KERB_WIDTH;
			h += 0.05 * Math.sin( f * Math.PI ) + 0.03 * Math.max( 0, Math.sin( out.s * Math.PI ) ); // raised, rumbling
		} else if ( al <= runoffEdge + 2 ) {
			out.surface = A.tunnel ? SURFACE.CONCRETE : this.runoffSurface;
			const f = ( al - kerbEdge );
			h += - 0.04 * f + ( this.runoffSurface === SURFACE.GRAVEL ? 0.015 * Math.sin( x * 3.1 ) * Math.cos( z * 2.7 ) : 0 );
		} else {
			out.surface = SURFACE.GRASS;
			h = this.terrainHeight( x, z, out );
		}
		out.height = h;
		return out;
	}

	/** Height of the ground outside the road, blended into the road edge. */
	terrainHeight( x, z, proj = null ) {
		const p = proj || this.project( x, z, - 1, this._tmpProj || ( this._tmpProj = {} ) );
		const edge = p.width / 2 + KERB_WIDTH + this.runoffWidth;
		const al = Math.abs( p.lateral );
		const edgeH = p.cy + edge * Math.sign( p.lateral || 1 ) * p.ry - 0.04 * ( edge - p.width / 2 - KERB_WIDTH );
		const raw = this.rawTerrainHeight( x, z, p );
		// a flat verge next to the road, then hills that start gently and grow with distance
		const verge = edgeH - 0.35 - ( al - edge ) * 0.03;
		const blend = smoothstep( edge + 6, edge + 140, al );
		const near = Math.min( verge, raw );
		return lerp( near, raw, blend );
	}

	/** Noise terrain for the biome, shaped relative to the nearby road elevation. */
	rawTerrainHeight( x, z, proj = null ) {
		const b = this.biome.terrain;
		const p = proj || this.project( x, z, - 1, this._tmpProj2 || ( this._tmpProj2 = {} ) );
		const al = Math.abs( p.lateral );
		// base elevation follows the track nearby and relaxes to the circuit's mean further out
		const base = lerp( p.cy, this.meanHeight, smoothstep( 60, 500, al ) ) + ( this.def.baseHeight ?? 0 );
		const relief = smoothstep( 10, 300, al ); // hills grow away from the circuit
		let h = base + fbm2( x * b.freq, z * b.freq, 4 ) * b.amp * ( 0.25 + 0.75 * relief );
		if ( b.ridge ) h += ridged2( x * b.freq * 0.5 + 3, z * b.freq * 0.5 ) * b.ridge * relief;
		if ( b.bowl ) { // distant hills ring the circuit
			const d = Math.hypot( x - this.bounds.cx, z - this.bounds.cz );
			h += smoothstep( 600, 1600, d ) * b.bowl;
		}
		return h;
	}

	/* ------------------------------------------------------------------------------------------ */
	/* Grid / start positions                                                                     */
	/* ------------------------------------------------------------------------------------------ */

	gridSlot( n, out = {} ) {
		const s = this.length - 14 - n * 7;
		const sm = this.sampleAt( s );
		const side = ( n % 2 === 0 ? - 1 : 1 ) * sm.width * 0.22;
		out.x = sm.pos.x + sm.right.x * side; out.z = sm.pos.z + sm.right.z * side;
		out.y = this.project( out.x, out.z, sm.index, this._tmpProj3 || ( this._tmpProj3 = {} ) ).height;
		out.heading = Math.atan2( sm.tangent.x, sm.tangent.z );
		out.quaternion = this.frameQuaternion( sm, out.quaternion );
		return out;
	}

	/** Orientation aligned with the road surface at a sample (car axes: +x left, +y up, +z forward). */
	frameQuaternion( sm, out = new Quaternion() ) {
		_v.copy( sm.right ).negate();
		return out.setFromRotationMatrix( new Matrix4().makeBasis( _v, sm.up, sm.tangent ) );
	}

	/* ------------------------------------------------------------------------------------------ */
	/* Meshes                                                                                     */
	/* ------------------------------------------------------------------------------------------ */

	buildMeshes( materials, quality ) {
		const g = this.group;
		g.add( this._buildRoad( materials.asphalt ) );
		g.add( this._buildKerbs( materials.kerb ) );
		g.add( this._buildRunoff( materials.runoff ) );
		for ( const m of this._buildBarriers( materials ) ) g.add( m );
		for ( const m of this._buildTunnels( materials ) ) g.add( m );
		g.add( this._buildTerrain( materials.terrain, quality ) );
		g.add( this._buildGantry( materials ) );
		return g;
	}

	_buildRoad( material ) {
		const S = this.samples, N = S.length;
		const gb = new GeometryBuilder( { along: 1 } );
		const rows = [];
		const lanes = [ - 0.5, - 0.25, 0, 0.25, 0.5 ];
		for ( let i = 0; i <= N; i ++ ) {
			const sm = S[ i % N ];
			const row = lanes.map( ( f ) => {
				const lat = f * sm.width;
				_v.copy( sm.pos ).addScaledVector( sm.right, lat );
				_v.y += 0.02 * ( 1 - ( 2 * f ) ** 2 );
				return gb.vertex( _v, sm.up, [ f + 0.5, i * SAMPLE_SPACING / 4 ], { along: i * SAMPLE_SPACING } );
			} );
			rows.push( row );
		}
		for ( let i = 0; i < N; i ++ ) gb.stitch( rows[ i ], rows[ i + 1 ], true );
		const mesh = new Mesh( gb.build(), material );
		mesh.receiveShadow = true;
		mesh.name = 'road';
		return mesh;
	}

	_buildKerbs( material ) {
		const S = this.samples, N = S.length;
		const gb = new GeometryBuilder( { along: 1 } );
		const profile = [ [ 0, 0 ], [ 0.5, 0.06 ], [ 1, 0.02 ] ];
		for ( const side of [ - 1, 1 ] ) {
			let prev = null;
			for ( let i = 0; i <= N; i ++ ) {
				const sm = S[ i % N ];
				const has = side < 0 ? sm.kerbL : sm.kerbR;
				if ( ! has ) { prev = null; continue; }
				const row = profile.map( ( [ f, h ] ) => {
					_v.copy( sm.pos ).addScaledVector( sm.right, side * ( sm.width / 2 + f * KERB_WIDTH ) ).addScaledVector( sm.up, h );
					return gb.vertex( _v, sm.up, [ f, i * SAMPLE_SPACING ], { along: i * SAMPLE_SPACING } );
				} );
				if ( prev ) gb.stitch( prev, row, side > 0 );
				prev = row;
			}
		}
		const mesh = new Mesh( gb.build(), material );
		mesh.receiveShadow = true; mesh.castShadow = false;
		mesh.name = 'kerbs';
		return mesh;
	}

	_buildRunoff( material ) {
		const S = this.samples, N = S.length;
		const gb = new GeometryBuilder( { along: 1 } );
		for ( const side of [ - 1, 1 ] ) {
			let prev = null;
			for ( let i = 0; i <= N; i ++ ) {
				const sm = S[ i % N ];
				if ( sm.tunnel ) { prev = null; continue; }
				const kerb = side < 0 ? sm.kerbL : sm.kerbR;
				const inner = sm.width / 2 + ( kerb ? KERB_WIDTH : 0 );
				const outer = inner + this.runoffWidth + 2;
				const row = [ 0, 0.5, 1 ].map( ( f ) => {
					const lat = lerp( inner, outer, f );
					_v.copy( sm.pos ).addScaledVector( sm.right, side * lat ).addScaledVector( sm.up, - 0.04 * ( lat - inner ) - 0.005 );
					return gb.vertex( _v, sm.up, [ f, i * SAMPLE_SPACING / 4 ], { along: i * SAMPLE_SPACING } );
				} );
				if ( prev ) gb.stitch( prev, row, side > 0 );
				prev = row;
			}
		}
		const mesh = new Mesh( gb.build( true ), material );
		mesh.receiveShadow = true;
		mesh.name = 'runoff';
		return mesh;
	}

	_buildBarriers( materials ) {
		const S = this.samples, N = S.length;
		const type = this.def.barrier || 'armco';
		const gb = new GeometryBuilder( { along: 1 } );
		const posts = [];
		// corrugated armco profile (lateral offset, height)
		const armco = [ [ 0, 0.35 ], [ 0.05, 0.5 ], [ 0, 0.65 ], [ 0.05, 0.8 ], [ 0, 0.95 ] ];
		const concrete = [ [ 0, 0 ], [ 0, 0.55 ], [ - 0.12, 0.85 ], [ - 0.14, 1.0 ], [ 0.1, 1.0 ], [ 0.1, 0 ] ];
		const safer = [ [ 0, 0 ], [ 0, 1.2 ], [ 0.3, 1.2 ], [ 0.3, 0 ] ];
		const profile = type === 'concrete' ? concrete : type === 'safer' ? safer : armco;
		for ( const side of [ - 1, 1 ] ) {
			let prev = null;
			for ( let i = 0; i <= N; i ++ ) {
				const sm = S[ i % N ];
				if ( sm.tunnel ) { prev = null; continue; }
				const kerb = side < 0 ? sm.kerbL : sm.kerbR;
				const base = sm.width / 2 + ( kerb ? KERB_WIDTH : 0 ) + this.runoffWidth + 0.4;
				const groundDrop = - 0.04 * ( this.runoffWidth );
				const row = profile.map( ( [ o, h ] ) => {
					_v.copy( sm.pos ).addScaledVector( sm.right, side * ( base + o ) ).addScaledVector( sm.up, groundDrop + h );
					_v2.copy( sm.right ).multiplyScalar( - side );
					return gb.vertex( _v, _v2, [ h, i * SAMPLE_SPACING ], { along: i * SAMPLE_SPACING } );
				} );
				if ( prev ) gb.stitch( prev, row, side > 0 );
				prev = row;
				if ( type === 'armco' && i % 2 === 0 ) {
					_v.copy( sm.pos ).addScaledVector( sm.right, side * ( base + 0.1 ) ).addScaledVector( sm.up, groundDrop + 0.45 );
					posts.push( { p: _v.clone(), t: sm.tangent.clone(), up: sm.up.clone() } );
				}
			}
		}
		const mesh = new Mesh( gb.build( type !== 'armco' ), type === 'concrete' ? materials.concrete : type === 'safer' ? materials.safer : materials.armco );
		mesh.castShadow = true; mesh.receiveShadow = true;
		mesh.name = 'barrier';
		const out = [ mesh ];
		if ( posts.length ) {
			const im = new InstancedMesh( new BoxGeometry( 0.12, 0.9, 0.12 ), materials.post, posts.length );
			const m = new Matrix4(), q = new Quaternion(), dummy = new Object3D();
			posts.forEach( ( p, i ) => {
				dummy.position.copy( p.p );
				dummy.quaternion.setFromUnitVectors( _up, p.up );
				dummy.updateMatrix();
				im.setMatrixAt( i, dummy.matrix );
			} );
			im.castShadow = true;
			im.name = 'posts';
			out.push( im );
		}
		return out;
	}

	_buildTunnels( materials ) {
		const S = this.samples, N = S.length;
		if ( ! this.tunnels.length ) return [];
		const gb = new GeometryBuilder( { along: 1 } );
		const lamps = [];
		for ( const tun of this.tunnels ) {
			let prev = null;
			let i = ( tun.from - 4 + N ) % N;
			const end = ( tun.to + 4 ) % N;
			let count = 0;
			while ( i !== end && count < N ) {
				const sm = S[ i ];
				const hw = sm.width / 2 + 1.2; // wall offset
				const H = 5.2;
				// profile: left wall bottom → top → arch → right wall top → bottom
				const prof = [];
				prof.push( [ - hw, - 0.1 ] ); prof.push( [ - hw, 2.6 ] );
				for ( let k = 0; k <= 8; k ++ ) {
					const a = Math.PI - k * Math.PI / 8;
					prof.push( [ Math.cos( a ) * hw, 2.6 + Math.sin( a ) * ( H - 2.6 ) ] );
				}
				prof.push( [ hw, 2.6 ] ); prof.push( [ hw, - 0.1 ] );
				const row = prof.map( ( [ o, h ], k ) => {
					_v.copy( sm.pos ).addScaledVector( sm.right, o ).addScaledVector( sm.up, h );
					return gb.vertex( _v, null, [ k / ( prof.length - 1 ), i * SAMPLE_SPACING / 4 ], { along: i * SAMPLE_SPACING } );
				} );
				if ( prev ) gb.stitch( prev, row, false );
				prev = row;
				if ( count % 6 === 3 ) {
					_v.copy( sm.pos ).addScaledVector( sm.up, H - 0.25 );
					lamps.push( { p: _v.clone(), t: sm.tangent.clone(), up: sm.up.clone(), right: sm.right.clone() } );
				}
				i = ( i + 1 ) % N; count ++;
			}
		}
		const mesh = new Mesh( gb.build( true ), materials.tunnel );
		mesh.castShadow = true; mesh.receiveShadow = true;
		mesh.name = 'tunnel';
		const out = [ mesh ];
		if ( lamps.length ) {
			const im = new InstancedMesh( new BoxGeometry( 1.6, 0.12, 0.3 ), materials.lamp, lamps.length );
			const dummy = new Object3D();
			lamps.forEach( ( l, i ) => {
				dummy.position.copy( l.p );
				dummy.matrix.makeBasis( l.right, l.up, l.t ).setPosition( l.p );
				im.setMatrixAt( i, dummy.matrix );
			} );
			im.name = 'lamps';
			out.push( im );
			this.lamps = lamps;
		}
		return out;
	}

	_buildTerrain( material, quality ) {
		const b = this.bounds;
		const margin = 700;
		const cell = quality?.terrainCell ?? 6;
		const minX = b.minX - margin, maxX = b.maxX + margin, minZ = b.minZ - margin, maxZ = b.maxZ + margin;
		const nx = Math.ceil( ( maxX - minX ) / cell ), nz = Math.ceil( ( maxZ - minZ ) / cell );
		const gb = new GeometryBuilder( { along: 1 } );
		const proj = {};
		const rows = [];
		for ( let j = 0; j <= nz; j ++ ) {
			const row = [];
			for ( let i = 0; i <= nx; i ++ ) {
				const x = minX + i * cell, z = minZ + j * cell;
				this.project( x, z, - 1, proj );
				const h = this.terrainHeight( x, z, proj );
				_v.set( x, h, z );
				row.push( gb.vertex( _v, null, [ i / nx, j / nz ], { along: Math.abs( proj.lateral ) } ) );
			}
			rows.push( row );
		}
		for ( let j = 0; j < nz; j ++ ) gb.stitch( rows[ j ], rows[ j + 1 ], false );
		const mesh = new Mesh( gb.build( true ), material );
		mesh.receiveShadow = true;
		mesh.name = 'terrain';
		return mesh;
	}

	_buildGantry( materials ) {
		const sm = this.samples[ 0 ];
		const g = new Group();
		g.name = 'gantry';
		const w = sm.width + 2 * ( KERB_WIDTH + this.runoffWidth ) + 2;
		const mk = ( geo, mat, x, y, z ) => {
			const m = new Mesh( geo, mat ); m.position.set( x, y, z ); m.castShadow = true; m.receiveShadow = true; g.add( m ); return m;
		};
		mk( new BoxGeometry( 0.5, 7, 0.5 ), materials.gantry, - w / 2, 3.5, 0 );
		mk( new BoxGeometry( 0.5, 7, 0.5 ), materials.gantry, w / 2, 3.5, 0 );
		mk( new BoxGeometry( w + 0.5, 1.6, 0.6 ), materials.gantry, 0, 7, 0 );
		const panel = mk( new BoxGeometry( w - 2, 1.0, 0.1 ), materials.gantryPanel, 0, 7, 0.36 );
		panel.castShadow = false;
		g.position.copy( sm.pos );
		g.quaternion.setFromRotationMatrix( new Matrix4().makeBasis( sm.right, sm.up, sm.tangent ) );
		return g;
	}
}
