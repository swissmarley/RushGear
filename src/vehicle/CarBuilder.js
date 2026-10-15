/**
 * CarBuilder — lofts a car body from the parametric stations in CarData and adds wheels,
 * lights, glass, spoiler, splitter, diffuser, mirrors, exhausts and an interior silhouette.
 *
 * Coordinate convention (car local): +z forward, +y up, +x = left side.
 */
import { Group, Mesh, Vector3, Vector2, CylinderGeometry, BoxGeometry, SphereGeometry, TorusGeometry, Matrix4, Quaternion, Object3D, InstancedMesh, LatheGeometry, Float32BufferAttribute } from 'three/webgpu';
import { GeometryBuilder } from '../world/GeometryBuilder.js';
import { lerp, clamp, smoothstep, makeRNG } from '../core/math.js';
import { makeCarUniforms, makePaintMaterial, makeGlassMaterial, makeLightMaterial, sharedCarMaterials } from './CarMaterials.js';

const _v = new Vector3();

/* Catmull-Rom over station parameters ---------------------------------------------------------- */
const KEYS = [ 'z', 'hw', 'floor', 'belt', 'roof', 'roofHw', 'round' ];
function interpStations( stations, count ) {
	const n = stations.length;
	const out = [];
	const cr = ( p0, p1, p2, p3, t ) => 0.5 * ( ( 2 * p1 ) + ( - p0 + p2 ) * t + ( 2 * p0 - 5 * p1 + 4 * p2 - p3 ) * t * t + ( - p0 + 3 * p1 - 3 * p2 + p3 ) * t * t * t );
	const total = n - 1;
	for ( let i = 0; i < count; i ++ ) {
		const u = i / ( count - 1 ) * total;
		const k = Math.min( Math.floor( u ), total - 1 ), t = u - k;
		const s0 = stations[ Math.max( 0, k - 1 ) ], s1 = stations[ k ], s2 = stations[ k + 1 ], s3 = stations[ Math.min( n - 1, k + 2 ) ];
		const st = {};
		for ( const key of KEYS ) st[ key ] = cr( s0[ key ], s1[ key ], s2[ key ], s3[ key ], t );
		out.push( st );
	}
	return out;
}

/** Half ring (left side, from bottom-centre to top-centre). Tags drive material assignment. */
function halfRing( st, archMask ) {
	const { hw, floor, belt, roof, roofHw, round } = st;
	const r = round;
	const pts = [];
	const push = ( x, y, tag ) => pts.push( { x, y, tag } );
	push( 0, floor, 'floor' );
	push( hw * 0.55, floor, 'floor' );
	push( hw * 0.88, floor + r * 0.25, 'floor' );
	push( hw, floor + r * 0.9, 'lower' );
	push( hw * 1.015, lerp( floor, belt, 0.45 ), 'lower' );
	push( hw * 1.0, belt - r * 0.45, 'lower' );
	push( hw - r * 0.35, belt, 'lower' );
	push( lerp( hw - r * 0.35, roofHw, 0.45 ), lerp( belt, roof, 0.5 ), 'glass' );
	push( roofHw, roof - r * 0.2, 'glass' );
	push( roofHw * 0.7, roof, 'roof' );
	push( 0, roof, 'roof' );
	// wheel arch: pull the lower side inward where a wheel lives
	if ( archMask > 0 ) {
		for ( const p of pts ) {
			if ( p.tag === 'lower' || ( p.tag === 'floor' && p.x > hw * 0.5 ) ) {
				const depth = archMask * 0.2;
				p.x = Math.max( 0.3, p.x - depth );
				if ( p.tag === 'floor' ) p.y += archMask * 0.05;
			}
		}
	}
	return pts;
}

export class CarBuilder {
	/**
	 * @param def   car definition from CarData
	 * @param opts  { quality, uniforms (optional existing set), seed }
	 */
	static build( def, opts = {} ) {
		const quality = opts.quality || { transmission: false };
		const cu = opts.uniforms || makeCarUniforms( def );
		cu.belt.value = def.stations[ Math.floor( def.stations.length / 2 ) ].belt;
		const shared = sharedCarMaterials();
		const group = new Group();
		group.name = 'car:' + def.id;

		const paintMat = makePaintMaterial( cu, quality );
		const glassMat = makeGlassMaterial( cu, quality );
		if ( opts.ghost ) { paintMat.transparent = true; paintMat.depthWrite = false; glassMat.transparent = true; }
		const headMat = makeLightMaterial( cu, 'head' );
		const tailMat = makeLightMaterial( cu, 'tail' );
		const revMat = makeLightMaterial( cu, 'reverse' );

		/* ---- body loft ------------------------------------------------------------------- */
		const rings = interpStations( def.stations, 56 );
		const wheelR = def.wheelRadius, wheelY = wheelR;
		const archR = wheelR + 0.09;
		const paint = new GeometryBuilder(), glass = new GeometryBuilder();
		const ringVerts = [];
		const axleZ = [ def.wheels.front + def.wheels.axleOffset, def.wheels.rear + def.wheels.axleOffset ];

		for ( let i = 0; i < rings.length; i ++ ) {
			const st = rings[ i ];
			let arch = 0;
			for ( const az of axleZ ) {
				const dz = Math.abs( st.z - az );
				arch = Math.max( arch, 1 - smoothstep( archR - 0.08, archR + 0.02, dz ) );
			}
			const half = halfRing( st, arch );
			// full ring: left side (positive x) from bottom to top, then right side mirrored from top to bottom
			const full = [];
			for ( const p of half ) full.push( { x: p.x, y: p.y, tag: p.tag } );
			for ( let k = half.length - 2; k >= 1; k -- ) full.push( { x: - half[ k ].x, y: half[ k ].y, tag: half[ k ].tag } );
			// arch cut: anything below the arch ceiling near the axle keeps a "well" — handled by halfRing inward pull
			const slope = i > 0 && i < rings.length - 1 ? Math.abs( rings[ i + 1 ].roof - rings[ i - 1 ].roof ) / Math.max( 1e-3, rings[ i + 1 ].z - rings[ i - 1 ].z ) : 0;
			const cabinH = st.roof - st.belt;
			ringVerts.push( { pts: full, z: st.z, hasCabin: cabinH > 0.14, glassTop: slope > 0.3 && cabinH > 0.14, archY: arch > 0.5 ? wheelY + archR : - 1 } );
		}

		// stitch rings; a face goes to glass when its tag is 'glass' or a sloped 'roof' (windscreen / rear window)
		const addRing = ( gb, ring ) => ring.pts.map( ( p ) => gb.vertex( _v.set( p.x, p.y, ring.z ), null, [ p.x, ring.z ] ) );
		const paintRows = ringVerts.map( ( r ) => addRing( paint, r ) );
		const glassRows = ringVerts.map( ( r ) => addRing( glass, r ) );
		const M = ringVerts[ 0 ].pts.length;
		for ( let i = 0; i < ringVerts.length - 1; i ++ ) {
			const A = ringVerts[ i ], B = ringVerts[ i + 1 ];
			for ( let j = 0; j < M; j ++ ) {
				const j2 = ( j + 1 ) % M;
				const tag = A.pts[ j ].tag === A.pts[ j2 ].tag ? A.pts[ j ].tag : ( A.pts[ j ].tag === 'glass' || A.pts[ j2 ].tag === 'glass' ? 'glass' : A.pts[ j ].tag );
				const isGlass = ( tag === 'glass' && A.hasCabin && B.hasCabin ) || ( tag === 'roof' && ( A.glassTop || B.glassTop ) && ( A.hasCabin || B.hasCabin ) );
				// degenerate (zero-height) glass faces on hood/trunk go to paint so there are no cracks
				const gh = Math.abs( A.pts[ j ].y - A.pts[ j2 ].y ) + Math.abs( B.pts[ j ].y - B.pts[ j2 ].y ) + Math.abs( A.pts[ j ].x - A.pts[ j2 ].x );
				const target = isGlass && gh > 0.01 ? glass : paint;
				const rows = target === glass ? glassRows : paintRows;
				// ring order: left side bottom→top then right side top→bottom = clockwise seen from the front (+z)
				target.quad( rows[ i ][ j ], rows[ i ][ j2 ], rows[ i + 1 ][ j2 ], rows[ i + 1 ][ j ] );
			}
		}
		// end caps (fans)
		const cap = ( gb, rows, ring, front ) => {
			const cx = gb.vertex( _v.set( 0, ( ring.pts[ 0 ].y + ring.pts[ Math.floor( M / 2 ) ].y ) / 2, ring.z ), null, [ 0, ring.z ] );
			for ( let j = 0; j < M; j ++ ) {
				const j2 = ( j + 1 ) % M;
				if ( front ) gb.tri( cx, rows[ j ], rows[ j2 ] ); else gb.tri( cx, rows[ j2 ], rows[ j ] );
			}
		};
		cap( paint, paintRows[ 0 ], ringVerts[ 0 ], false );
		cap( paint, paintRows[ ringVerts.length - 1 ], ringVerts[ ringVerts.length - 1 ], true );

		const bodyGeo = paint.build( true );
		const body = new Mesh( bodyGeo, paintMat );
		body.castShadow = true; body.receiveShadow = true; body.name = 'body';
		body.userData.restPositions = bodyGeo.attributes.position.array.slice();
		group.add( body );
		const glassGeo = glass.build( true );
		if ( glassGeo.index.count > 0 ) {
			const gm = new Mesh( glassGeo, glassMat );
			gm.castShadow = false; gm.name = 'glass'; gm.renderOrder = 10;
			group.add( gm );
		}

		/* ---- underbody & arch liners --------------------------------------------------- */
		const first = def.stations[ 0 ], last = def.stations[ def.stations.length - 1 ];
		const under = new Mesh( new BoxGeometry( def.trackR * 0.95, 0.06, last.z - first.z - 0.6 ), shared.plastic );
		under.position.set( 0, Math.min( first.floor, def.stations[ 3 ].floor ) - 0.01, ( first.z + last.z ) / 2 );
		under.name = 'underbody';
		group.add( under );
		for ( const az of axleZ ) for ( const side of [ - 1, 1 ] ) {
			const liner = new Mesh( new CylinderGeometry( archR, archR, 0.42, 16, 1, true, 0, Math.PI ), shared.plastic );
			liner.rotation.z = Math.PI / 2; liner.rotation.y = Math.PI / 2;
			liner.position.set( side * ( def.trackF / 2 - 0.1 ), wheelY, az );
			liner.material = shared.plastic;
			group.add( liner );
		}

		/* ---- wheels ---------------------------------------------------------------------- */
		const wheels = [];
		const tyreGeo = new CylinderGeometry( wheelR, wheelR, def.wheelWidth, 28, 1 );
		const rimGeo = new CylinderGeometry( wheelR * 0.68, wheelR * 0.64, def.wheelWidth * 0.9, 24, 1 );
		rimGeo.computeTangents();
		const spokeGeo = new BoxGeometry( def.wheelWidth * 0.5, wheelR * 1.3, wheelR * 0.14 );
		const hubGeo = new CylinderGeometry( wheelR * 0.18, wheelR * 0.18, def.wheelWidth * 0.98, 12 );
		const discGeo = new CylinderGeometry( wheelR * 0.56, wheelR * 0.56, 0.03, 24 );
		discGeo.computeTangents();
		const calGeo = new BoxGeometry( 0.08, wheelR * 0.5, 0.12 );
		const axles = [ { z: axleZ[ 0 ], tw: def.trackF }, { z: axleZ[ 1 ], tw: def.trackR } ];
		let wi = 0;
		for ( const axle of axles ) for ( const side of [ 1, - 1 ] ) {
			const pivot = new Group(); // steering pivot (yaw)
			pivot.position.set( side * axle.tw / 2, wheelY, axle.z );
			const spin = new Group();   // rolling (pitch)
			pivot.add( spin );
			const tyre = new Mesh( tyreGeo, shared.tyre );
			tyre.rotation.z = Math.PI / 2;
			tyre.castShadow = true;
			spin.add( tyre );
			const rim = new Mesh( rimGeo, shared.rim ); rim.rotation.z = Math.PI / 2; rim.position.x = side * 0.02; spin.add( rim );
			for ( let k = 0; k < 5; k ++ ) {
				const sp = new Mesh( spokeGeo, shared.rim );
				sp.rotation.x = k * Math.PI * 2 / 5;
				sp.position.x = side * def.wheelWidth * 0.3;
				spin.add( sp );
			}
			const hub = new Mesh( hubGeo, shared.chrome ); hub.rotation.z = Math.PI / 2; spin.add( hub );
			// brake disc + calliper don't spin
			const disc = new Mesh( discGeo, shared.disc ); disc.rotation.z = Math.PI / 2; disc.position.x = side * 0.04; pivot.add( disc );
			const cal = new Mesh( calGeo, shared.calliper ); cal.position.set( side * 0.06, wheelR * 0.1, - wheelR * 0.45 ); pivot.add( cal );
			pivot.name = 'wheel' + wi;
			pivot.userData = { side, front: axle === axles[ 0 ], restY: wheelY };
			group.add( pivot );
			wheels.push( { pivot, spin, side, front: axle === axles[ 0 ] } );
			wi ++;
		}

		/* ---- lights ----------------------------------------------------------------------- */
		const nose = last, tail = first;
		const headGeo = def.lights.head === 'slim' ? new BoxGeometry( 0.42, 0.06, 0.08 ) : def.lights.head === 'round' ? new CylinderGeometry( 0.12, 0.12, 0.06, 16 ) : new SphereGeometry( 0.11, 16, 12 );
		for ( const side of [ - 1, 1 ] ) {
			const h = new Mesh( headGeo, headMat );
			h.position.set( side * nose.hw * 0.72, lerp( nose.floor, nose.belt, 0.7 ), nose.z - 0.02 );
			if ( def.lights.head === 'oval' ) h.scale.set( 1.4, 0.7, 0.6 );
			if ( def.lights.head === 'round' ) h.rotation.x = Math.PI / 2;
			h.name = 'headlight';
			group.add( h );
		}
		const tailGeo = def.lights.tail === 'bar' ? new BoxGeometry( tail.hw * 1.7, 0.09, 0.06 ) : new BoxGeometry( 0.36, 0.12, 0.06 );
		if ( def.lights.tail === 'bar' ) {
			const t = new Mesh( tailGeo, tailMat ); t.position.set( 0, lerp( tail.floor, tail.belt, 0.68 ), tail.z + 0.01 ); group.add( t );
		} else for ( const side of [ - 1, 1 ] ) {
			const t = new Mesh( tailGeo, tailMat ); t.position.set( side * tail.hw * 0.7, lerp( tail.floor, tail.belt, 0.68 ), tail.z + 0.01 ); group.add( t );
		}
		for ( const side of [ - 1, 1 ] ) {
			const rv = new Mesh( new BoxGeometry( 0.12, 0.05, 0.05 ), revMat );
			rv.position.set( side * tail.hw * 0.5, lerp( tail.floor, tail.belt, 0.5 ), tail.z + 0.01 );
			group.add( rv );
		}

		/* ---- aero & trim ------------------------------------------------------------------ */
		const sp = def.spoiler;
		if ( sp && sp.type === 'wing' ) {
			const wing = new Mesh( new BoxGeometry( tail.hw * 1.9, 0.03, 0.26 ), shared.carbon );
			wing.position.set( 0, tail.roof + sp.height, tail.z + 0.15 );
			wing.rotation.x = - 0.15;
			wing.castShadow = true;
			group.add( wing );
			for ( const side of [ - 1, 1 ] ) {
				const strut = new Mesh( new BoxGeometry( 0.03, sp.height, 0.16 ), shared.carbon );
				strut.position.set( side * tail.hw * 0.65, tail.roof + sp.height / 2, tail.z + 0.18 );
				group.add( strut );
			}
		} else if ( sp && sp.type === 'lip' ) {
			const lip = new Mesh( new BoxGeometry( tail.hw * 1.8, sp.height, 0.08 ), shared.carbon );
			lip.position.set( 0, tail.roof + sp.height / 2, tail.z + 0.06 );
			group.add( lip );
		} else if ( sp && sp.type === 'roof' ) {
			const rs = new Mesh( new BoxGeometry( tail.roofHw * 2.0, 0.05, 0.3 ), paintMat );
			rs.position.set( 0, tail.roof + 0.03, tail.z + 0.2 ); rs.rotation.x = - 0.2; group.add( rs );
		} else if ( sp && sp.type === 'ducktail' ) {
			const d = new Mesh( new BoxGeometry( tail.hw * 1.7, 0.05, 0.3 ), paintMat );
			d.position.set( 0, tail.roof + 0.04, tail.z + 0.12 ); d.rotation.x = - 0.35; group.add( d );
		}
		const splitter = new Mesh( new BoxGeometry( nose.hw * 2.1, 0.025, 0.32 ), shared.carbon );
		splitter.position.set( 0, nose.floor - 0.03, nose.z - 0.12 ); group.add( splitter );
		const diffuser = new Mesh( new BoxGeometry( tail.hw * 1.6, 0.18, 0.3 ), shared.carbon );
		diffuser.position.set( 0, tail.floor - 0.02, tail.z + 0.1 ); diffuser.rotation.x = 0.3; group.add( diffuser );
		const grille = new Mesh( new BoxGeometry( nose.hw * 0.9, 0.16, 0.05 ), shared.plastic );
		grille.position.set( 0, lerp( nose.floor, nose.belt, 0.35 ), nose.z - 0.01 ); group.add( grille );
		// mirrors
		const mid = def.stations[ Math.floor( def.stations.length / 2 ) ];
		for ( const side of [ - 1, 1 ] ) {
			const m = new Mesh( new BoxGeometry( 0.2, 0.09, 0.12 ), paintMat );
			m.position.set( side * ( mid.hw + 0.1 ), mid.belt + 0.05, def.cabin.end - 0.1 );
			group.add( m );
			const arm = new Mesh( new BoxGeometry( 0.12, 0.02, 0.04 ), shared.plastic );
			arm.position.set( side * ( mid.hw + 0.02 ), mid.belt + 0.03, def.cabin.end - 0.1 );
			group.add( arm );
		}
		// exhausts
		const exGeo = new CylinderGeometry( 0.045, 0.045, 0.16, 12 );
		const exX = def.exhaust === 'centre' ? [ - 0.08, 0.08 ] : def.exhaust === 'quad' ? [ - 0.55, - 0.42, 0.42, 0.55 ] : [ - 0.45, 0.45 ];
		for ( const x of exX ) {
			const e = new Mesh( exGeo, shared.chrome ); e.rotation.x = Math.PI / 2; e.position.set( x, tail.floor + 0.06, tail.z + 0.02 ); group.add( e );
		}
		// interior silhouette: dash, seats, wheel
		const cab = def.cabin;
		const dash = new Mesh( new BoxGeometry( mid.hw * 1.6, 0.18, 0.5 ), shared.interior );
		dash.position.set( 0, mid.belt - 0.05, cab.end - 0.3 ); group.add( dash );
		for ( const side of [ - 1, 1 ] ) {
			const seat = new Mesh( new BoxGeometry( 0.48, 0.6, 0.5 ), shared.interior );
			seat.position.set( side * 0.36, mid.belt - 0.2, cab.start + 0.6 ); group.add( seat );
		}
		const sw = new Mesh( new TorusGeometry( 0.17, 0.02, 8, 20 ), shared.interior );
		sw.position.set( 0.36, mid.belt - 0.02, cab.end - 0.5 ); sw.rotation.x = 0.4; group.add( sw );

		group.userData = { wheels, uniforms: cu, def, body, paintMat, glassMat };
		return { group, wheels, uniforms: cu, body, materials: { paint: paintMat, glass: glassMat } };
	}

	/** Deform the body mesh around a world-space impact point (visual damage). */
	static dent( car, localPoint, strength ) {
		const body = car.body;
		const pos = body.geometry.attributes.position;
		const arr = pos.array;
		const r = 0.45 + strength * 0.3;
		const rng = makeRNG( ( localPoint.x * 100 + localPoint.z * 37 ) | 0 );
		for ( let i = 0; i < arr.length; i += 3 ) {
			const dx = arr[ i ] - localPoint.x, dy = arr[ i + 1 ] - localPoint.y, dz = arr[ i + 2 ] - localPoint.z;
			const d = Math.sqrt( dx * dx + dy * dy + dz * dz );
			if ( d > r ) continue;
			const f = ( 1 - d / r ) ** 2 * strength * 0.12;
			// push toward the car centre line with a little randomness
			arr[ i ] -= Math.sign( arr[ i ] ) * f * ( 0.6 + rng() * 0.4 );
			arr[ i + 2 ] -= Math.sign( localPoint.z ) * f * 0.6;
			arr[ i + 1 ] += ( rng() - 0.5 ) * f * 0.3;
		}
		pos.needsUpdate = true;
		body.geometry.computeVertexNormals();
	}

	static repair( car ) {
		const body = car.body;
		body.geometry.attributes.position.array.set( body.userData.restPositions );
		body.geometry.attributes.position.needsUpdate = true;
		body.geometry.computeVertexNormals();
	}
}
