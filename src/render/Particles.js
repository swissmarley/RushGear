/**
 * GPU particle pools. The CPU only writes spawn records (position, velocity, time, life, size,
 * seed) into a ring buffer of instanced attributes; the vertex shader integrates motion
 * analytically (drag + gravity) from the spawn record, so there is no per-frame CPU update
 * and no readback. Billboarding, growth, fading and procedural sprite shapes are all TSL.
 */
import { Mesh, PlaneGeometry, InstancedBufferGeometry, InstancedBufferAttribute, MeshBasicNodeMaterial, AdditiveBlending, NormalBlending, Vector3, DoubleSide } from 'three/webgpu';
import { Fn, vec2, vec3, vec4, float, uv, positionLocal, cameraWorldMatrix, cameraPosition, instancedBufferAttribute, time, mix, smoothstep, max, min, exp, length, clamp, saturate, oneMinus, hash, fract, mx_noise_float, sin, cos, normalize, dot, step, floor } from 'three/tsl';
import { U } from './Uniforms.js';

const KINDS = {
	smoke: { blending: NormalBlending, gravity: - 0.6, drag: 1.6, grow: 2.2, soft: 1, base: [ 0.75, 0.74, 0.72 ], fadeIn: 0.08, depthTest: true },
	dust: { blending: NormalBlending, gravity: 0.4, drag: 1.2, grow: 2.0, soft: 1, base: [ 0.62, 0.5, 0.36 ], fadeIn: 0.05, depthTest: true },
	grass: { blending: NormalBlending, gravity: 7.0, drag: 1.0, grow: 0.0, soft: 0, base: [ 0.25, 0.42, 0.12 ], fadeIn: 0.0, depthTest: true },
	spray: { blending: NormalBlending, gravity: 3.0, drag: 1.8, grow: 1.6, soft: 1, base: [ 0.8, 0.85, 0.9 ], fadeIn: 0.0, depthTest: true },
	spark: { blending: AdditiveBlending, gravity: 9.8, drag: 0.6, grow: - 0.4, soft: 0, base: [ 1.0, 0.65, 0.25 ], fadeIn: 0.0, depthTest: true },
	debris: { blending: NormalBlending, gravity: 9.8, drag: 0.5, grow: 0.0, soft: 0, base: [ 0.1, 0.1, 0.1 ], fadeIn: 0.0, depthTest: true },
	flame: { blending: AdditiveBlending, gravity: - 2.0, drag: 4.0, grow: 1.0, soft: 0, base: [ 1.0, 0.5, 0.1 ], fadeIn: 0.0, depthTest: true }
};

export class ParticlePool {
	constructor( kind, count ) {
		this.kind = kind;
		this.cfg = KINDS[ kind ];
		this.count = count;
		this.head = 0;
		this.a0 = new Float32Array( count * 4 ); // pos.xyz, spawnTime
		this.a1 = new Float32Array( count * 4 ); // vel.xyz, life
		this.a2 = new Float32Array( count * 4 ); // size, seed, tint, groundY
		// dead particles: spawned far in the past with a finite life (never divide by zero → no NaNs)
		for ( let i = 0; i < count; i ++ ) { this.a0[ i * 4 + 3 ] = - 1e5; this.a1[ i * 4 + 3 ] = 1; this.a2[ i * 4 ] = 0; this.a2[ i * 4 + 3 ] = - 1e4; }
		this.attr0 = new InstancedBufferAttribute( this.a0, 4 ); this.attr0.setUsage( 35048 );
		this.attr1 = new InstancedBufferAttribute( this.a1, 4 ); this.attr1.setUsage( 35048 );
		this.attr2 = new InstancedBufferAttribute( this.a2, 4 ); this.attr2.setUsage( 35048 );
		const quad = new PlaneGeometry( 1, 1 );
		const geo = new InstancedBufferGeometry();
		geo.setAttribute( 'position', quad.attributes.position );
		geo.setAttribute( 'uv', quad.attributes.uv );
		geo.setIndex( quad.index );
		geo.instanceCount = count;
		geo.setAttribute( 'p0', this.attr0 ); geo.setAttribute( 'p1', this.attr1 ); geo.setAttribute( 'p2', this.attr2 );
		this.mesh = new Mesh( geo, this._material() );
		this.mesh.frustumCulled = false;
		this.mesh.name = 'particles:' + kind;
		this.mesh.renderOrder = kind === 'spark' || kind === 'flame' ? 20 : 15;
		this.dirty = false;
	}

	_material() {
		const c = this.cfg;
		const mat = new MeshBasicNodeMaterial();
		mat.transparent = true; mat.depthWrite = false; mat.blending = c.blending; mat.side = DoubleSide; mat.fog = false;
		const p0 = instancedBufferAttribute( this.attr0 ), p1 = instancedBufferAttribute( this.attr1 ), p2 = instancedBufferAttribute( this.attr2 );
		const age = U.time.sub( p0.w ).toVar();
		const life = max( p1.w, 0.01 );
		const t = saturate( age.div( life ) ).toVar();
		const alive = step( 0.0, age ).mul( step( age, life ) );
		const k = float( c.drag );
		// p = p0 + v0 (1 - e^{-k a}) / k + ½ g a²
		const disp = p1.xyz.mul( oneMinus( exp( age.mul( k ).negate() ) ).div( k ) );
		const grav = vec3( 0.0, float( c.gravity ).negate().mul( 0.5 ).mul( age ).mul( age ), 0.0 );
		let center = p0.xyz.add( disp ).add( grav ).toVar();
		const size = p2.x.mul( float( 1.0 ).add( t.mul( c.grow ) ) ).mul( alive );
		// keep puffs above the ground they were spawned on
		center = vec3( center.x, max( center.y, p2.w.add( size.mul( 0.35 ) ) ), center.z );
		// billboard using the camera's world axes; sparks stretch along their motion
		const right = cameraWorldMatrix.element( 0 ).xyz, up = cameraWorldMatrix.element( 1 ).xyz;
		const seed = p2.y;
		const rot = seed.mul( 6.28 ).add( age.mul( seed.sub( 0.5 ) ).mul( 1.5 ) );
		const cx = positionLocal.x.mul( cos( rot ) ).sub( positionLocal.y.mul( sin( rot ) ) ), cy = positionLocal.x.mul( sin( rot ) ).add( positionLocal.y.mul( cos( rot ) ) );
		let offset;
		if ( this.kind === 'spark' || this.kind === 'debris' ) {
			const vel = p1.xyz.mul( exp( age.mul( k ).negate() ) ).add( vec3( 0.0, float( c.gravity ).negate().mul( age ), 0.0 ) );
			const dir = normalize( vel.add( vec3( 0.0, 0.001, 0.0 ) ) );
			const side = normalize( vec3( dir.z, 0.0, dir.x.negate() ).add( vec3( 0.001, 0.0, 0.0 ) ) );
			offset = dir.mul( positionLocal.y.mul( size ).mul( 4.0 ) ).add( side.mul( positionLocal.x.mul( size ) ) );
		} else offset = right.mul( cx.mul( size ) ).add( up.mul( cy.mul( size ) ) );
		mat.positionNode = center.add( offset );

		// sprite shape
		const d = length( uv().sub( 0.5 ) ).mul( 2.0 );
		let shape;
		if ( this.kind === 'smoke' || this.kind === 'dust' || this.kind === 'spray' ) {
			const n = mx_noise_float( vec3( uv().mul( 3.0 ), seed.mul( 10.0 ).add( age.mul( 0.3 ) ) ) ).mul( 0.5 ).add( 0.5 );
			shape = smoothstep( 1.0, 0.2, d.add( n.mul( 0.5 ) ) ).mul( n.mul( 0.6 ).add( 0.6 ) );
		} else if ( this.kind === 'grass' || this.kind === 'debris' ) {
			shape = step( d, 0.9 );
		} else shape = smoothstep( 1.0, 0.0, d );
		const fadeIn = c.fadeIn > 0 ? smoothstep( 0.0, c.fadeIn, t ) : float( 1.0 );
		const fadeOut = this.kind === 'spark' ? oneMinus( t ).pow( 0.5 ) : oneMinus( t ).pow( 1.4 );
		const tint = p2.z; // 0..1 → darkness / heat
		let color = vec3( ...c.base );
		if ( this.kind === 'smoke' ) color = color.mul( oneMinus( tint.mul( 0.7 ) ) );
		if ( this.kind === 'spark' || this.kind === 'flame' ) color = mix( vec3( 1.0, 0.95, 0.6 ), vec3( 1.0, 0.25, 0.05 ), t ).mul( float( 4.0 ).sub( t.mul( 3.0 ) ) );
		// lighting: puffs take the sun + sky tint (unlit material)
		const litTint = U.sunColor.mul( U.sunIntensity.mul( 0.22 ) ).add( U.skyZenith.mul( 0.6 ) ).add( 0.05 );
		if ( this.kind === 'smoke' || this.kind === 'dust' || this.kind === 'spray' || this.kind === 'grass' ) color = color.mul( litTint );
		mat.colorNode = color;
		mat.opacityNode = shape.mul( fadeIn ).mul( fadeOut ).mul( alive ).mul( this.kind === 'smoke' ? 0.55 : this.kind === 'spray' ? 0.4 : 1.0 );
		return mat;
	}

	/** Spawn one particle. */
	spawn( now, x, y, z, vx, vy, vz, life, size, seed, tint, groundY ) {
		const i = this.head; this.head = ( this.head + 1 ) % this.count;
		const o = i * 4;
		this.a0[ o ] = x; this.a0[ o + 1 ] = y; this.a0[ o + 2 ] = z; this.a0[ o + 3 ] = now;
		this.a1[ o ] = vx; this.a1[ o + 1 ] = vy; this.a1[ o + 2 ] = vz; this.a1[ o + 3 ] = life;
		this.a2[ o ] = size; this.a2[ o + 1 ] = seed; this.a2[ o + 2 ] = tint; this.a2[ o + 3 ] = groundY;
		this.dirty = true;
	}

	/** Upload spawn records (whole buffer; a few KB per pool). */
	flush() {
		if ( ! this.dirty ) return;
		this.attr0.needsUpdate = true; this.attr1.needsUpdate = true; this.attr2.needsUpdate = true;
		this.dirty = false;
	}
}

/**
 * Rain: a fixed cloud of streaks wrapped around the camera. Each instance has a seed; its
 * position is a function of time, so it never needs CPU updates.
 */
export class RainSystem {
	constructor( count = 6000 ) {
		this.count = count;
		const seeds = new Float32Array( count * 4 );
		for ( let i = 0; i < count; i ++ ) { seeds[ i * 4 ] = Math.random(); seeds[ i * 4 + 1 ] = Math.random(); seeds[ i * 4 + 2 ] = Math.random(); seeds[ i * 4 + 3 ] = Math.random(); }
		const attr = new InstancedBufferAttribute( seeds, 4 );
		const quad = new PlaneGeometry( 1, 1 );
		const geo = new InstancedBufferGeometry();
		geo.setAttribute( 'position', quad.attributes.position ); geo.setAttribute( 'uv', quad.attributes.uv ); geo.setIndex( quad.index );
		geo.setAttribute( 'seed', attr ); geo.instanceCount = count;
		const mat = new MeshBasicNodeMaterial();
		mat.transparent = true; mat.depthWrite = false; mat.blending = NormalBlending; mat.side = DoubleSide; mat.fog = false;
		const s = instancedBufferAttribute( attr );
		const BOX = vec3( 40.0, 24.0, 40.0 );
		const fall = float( 14.0 ).add( s.w.mul( 6.0 ) );
		// wrap inside a box around the camera; wind drifts streaks sideways
		const wind = vec3( 2.5, 0.0, 1.0 );
		const raw = vec3( s.x, s.y, s.z ).mul( BOX ).add( vec3( 0.0, time.mul( fall ).negate(), 0.0 ) ).add( wind.mul( time ) );
		const wrapped = fract( raw.add( cameraPosition ).div( BOX ).add( 0.5 ) ).sub( 0.5 ).mul( BOX ).add( cameraPosition.add( vec3( 0.0, 4.0, 0.0 ) ) );
		// hide drops in tunnels (camera y vs. the tunnel flag is cheap to pass as a uniform)
		const dir = normalize( vec3( wind.x.mul( 0.05 ), fall.negate(), wind.z.mul( 0.05 ) ) );
		const len = float( 0.35 ).add( s.w.mul( 0.4 ) );
		const right = cameraWorldMatrix.element( 0 ).xyz;
		mat.positionNode = wrapped.add( dir.mul( positionLocal.y.mul( len ) ) ).add( right.mul( positionLocal.x.mul( 0.012 ) ) );
		const d = uv().x.sub( 0.5 ).abs().mul( 2.0 );
		mat.colorNode = vec3( 0.7, 0.75, 0.85 ).add( U.night.mul( 0.2 ) );
		mat.opacityNode = oneMinus( d ).mul( U.rainLocal ).mul( 0.35 ).mul( smoothstep( 0.0, 0.15, uv().y ) ).mul( smoothstep( 1.0, 0.85, uv().y ) );
		this.mesh = new Mesh( geo, mat );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 18;
		this.mesh.name = 'rain';
	}
}

