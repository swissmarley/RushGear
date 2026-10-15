/**
 * Tiny indexed-geometry accumulator used by every procedural mesh builder.
 * Supports arbitrary extra float attributes (e.g. 'along' for kerb stripes).
 */
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three/webgpu';

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();

export class GeometryBuilder {
	constructor( extraAttributes = {} ) {
		this.positions = []; this.normals = []; this.uvs = []; this.indices = [];
		this.extra = {};
		for ( const name in extraAttributes ) this.extra[ name ] = { size: extraAttributes[ name ], data: [] };
	}
	get vertexCount() { return this.positions.length / 3; }

	vertex( p, n, uv, extra ) {
		this.positions.push( p.x, p.y, p.z );
		this.normals.push( n ? n.x : 0, n ? n.y : 1, n ? n.z : 0 );
		this.uvs.push( uv ? uv[ 0 ] : 0, uv ? uv[ 1 ] : 0 );
		if ( extra ) for ( const name in extra ) {
			const e = this.extra[ name ];
			const v = extra[ name ];
			if ( e.size === 1 ) e.data.push( v ); else e.data.push( ...v );
		}
		return this.vertexCount - 1;
	}
	tri( a, b, c ) { this.indices.push( a, b, c ); }
	quad( a, b, c, d ) { this.indices.push( a, b, c, a, c, d ); }

	/** Join two vertex rows (same length) with quads. */
	stitch( rowA, rowB, flip = false ) {
		for ( let i = 0; i < rowA.length - 1; i ++ ) {
			if ( flip ) this.quad( rowA[ i ], rowA[ i + 1 ], rowB[ i + 1 ], rowB[ i ] );
			else this.quad( rowA[ i ], rowB[ i ], rowB[ i + 1 ], rowA[ i + 1 ] );
		}
	}

	/** Recompute smooth normals from faces (used when a builder passes null normals). */
	computeNormals() {
		const pos = this.positions, n = new Float32Array( pos.length );
		for ( let i = 0; i < this.indices.length; i += 3 ) {
			const ia = this.indices[ i ] * 3, ib = this.indices[ i + 1 ] * 3, ic = this.indices[ i + 2 ] * 3;
			_a.set( pos[ ia ], pos[ ia + 1 ], pos[ ia + 2 ] );
			_b.set( pos[ ib ], pos[ ib + 1 ], pos[ ib + 2 ] );
			_c.set( pos[ ic ], pos[ ic + 1 ], pos[ ic + 2 ] );
			_b.sub( _a ); _c.sub( _a ); _b.cross( _c );
			for ( const j of [ ia, ib, ic ] ) { n[ j ] += _b.x; n[ j + 1 ] += _b.y; n[ j + 2 ] += _b.z; }
		}
		for ( let i = 0; i < n.length; i += 3 ) {
			const l = Math.hypot( n[ i ], n[ i + 1 ], n[ i + 2 ] ) || 1;
			n[ i ] /= l; n[ i + 1 ] /= l; n[ i + 2 ] /= l;
		}
		this.normals = Array.from( n );
	}

	build( smooth = false ) {
		if ( smooth ) this.computeNormals();
		const g = new BufferGeometry();
		g.setAttribute( 'position', new Float32BufferAttribute( this.positions, 3 ) );
		g.setAttribute( 'normal', new Float32BufferAttribute( this.normals, 3 ) );
		g.setAttribute( 'uv', new Float32BufferAttribute( this.uvs, 2 ) );
		for ( const name in this.extra ) g.setAttribute( name, new Float32BufferAttribute( this.extra[ name ].data, this.extra[ name ].size ) );
		g.setIndex( this.indices );
		g.computeBoundingSphere();
		g.computeBoundingBox();
		return g;
	}
}
