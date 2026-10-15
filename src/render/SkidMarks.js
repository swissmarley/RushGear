/**
 * Persistent tyre marks: a ring buffer of quads laid along each skidding wheel's contact path.
 * Marks darken the road, fade slowly over minutes and cost one draw call.
 */
import { Mesh, BufferGeometry, BufferAttribute, MeshBasicNodeMaterial, Vector3, NormalBlending } from 'three/webgpu';
import { attribute, vec3, float, time, smoothstep, oneMinus, mix, uv, abs, saturate } from 'three/tsl';
import { U } from './Uniforms.js';

const _a = new Vector3(), _b = new Vector3();

export class SkidMarks {
	constructor( maxQuads = 3000 ) {
		this.max = maxQuads;
		this.head = 0;
		this.pos = new Float32Array( maxQuads * 4 * 3 );
		this.info = new Float32Array( maxQuads * 4 * 3 ); // intensity, birth, u
		const index = new Uint32Array( maxQuads * 6 );
		for ( let i = 0; i < maxQuads; i ++ ) { const v = i * 4, o = i * 6; index[ o ] = v; index[ o + 1 ] = v + 1; index[ o + 2 ] = v + 2; index[ o + 3 ] = v; index[ o + 4 ] = v + 2; index[ o + 5 ] = v + 3; }
		const geo = new BufferGeometry();
		this.posAttr = new BufferAttribute( this.pos, 3 ); this.posAttr.setUsage( 35048 );
		this.infoAttr = new BufferAttribute( this.info, 3 ); this.infoAttr.setUsage( 35048 );
		geo.setAttribute( 'position', this.posAttr );
		geo.setAttribute( 'info', this.infoAttr );
		geo.setIndex( new BufferAttribute( index, 1 ) );
		geo.setDrawRange( 0, 0 );
		const mat = new MeshBasicNodeMaterial();
		mat.transparent = true; mat.depthWrite = false; mat.polygonOffset = true; mat.polygonOffsetFactor = - 4; mat.polygonOffsetUnits = - 4; mat.fog = false;
		const info = attribute( 'info', 'vec3' );
		const age = U.time.sub( info.y );
		const fade = oneMinus( smoothstep( 60.0, 300.0, age ) );
		const edge = oneMinus( abs( info.z.sub( 0.5 ) ).mul( 2.0 ) );
		mat.colorNode = vec3( 0.02, 0.02, 0.022 );
		mat.opacityNode = info.x.mul( fade ).mul( smoothstep( 0.0, 0.35, edge ) ).mul( 0.75 ).mul( oneMinus( U.wetness.mul( 0.4 ) ) );
		this.mesh = new Mesh( geo, mat );
		this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.name = 'skidmarks';
		this.geometry = geo;
		this.count = 0;
		this.dirty = false;
	}

	/** Add a quad from the previous contact pair to the current one. */
	addQuad( pl, pr, cl, cr, intensity, now ) {
		const i = this.head; this.head = ( this.head + 1 ) % this.max;
		const o = i * 12, k = i * 12;
		this.pos[ o ] = pl.x; this.pos[ o + 1 ] = pl.y; this.pos[ o + 2 ] = pl.z;
		this.pos[ o + 3 ] = pr.x; this.pos[ o + 4 ] = pr.y; this.pos[ o + 5 ] = pr.z;
		this.pos[ o + 6 ] = cr.x; this.pos[ o + 7 ] = cr.y; this.pos[ o + 8 ] = cr.z;
		this.pos[ o + 9 ] = cl.x; this.pos[ o + 10 ] = cl.y; this.pos[ o + 11 ] = cl.z;
		const us = [ 0, 1, 1, 0 ];
		for ( let v = 0; v < 4; v ++ ) { this.info[ k + v * 3 ] = intensity; this.info[ k + v * 3 + 1 ] = now; this.info[ k + v * 3 + 2 ] = us[ v ]; }
		this.count = Math.min( this.max, this.count + 1 );
		this.dirty = true;
	}

	flush() {
		if ( ! this.dirty ) return;
		this.posAttr.needsUpdate = true; this.infoAttr.needsUpdate = true;
		this.geometry.setDrawRange( 0, this.count * 6 );
		this.dirty = false;
	}

	clear() { this.count = 0; this.head = 0; this.geometry.setDrawRange( 0, 0 ); }
}
