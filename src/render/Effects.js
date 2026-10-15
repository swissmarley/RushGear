/**
 * Effects manager: turns vehicle telemetry into particles and marks.
 *   tyre smoke (skid on asphalt), dust (gravel/sand), grass clumps, spray (wet), sparks and
 *   debris (collisions, bottoming out), exhaust flames (throttle lift at high rpm), rain.
 */
import { Vector3, Group } from 'three/webgpu';
import { ParticlePool, RainSystem } from './Particles.js';
import { SkidMarks } from './SkidMarks.js';
import { SURFACE } from '../world/Track.js';
import { clamp, makeRNG } from '../core/math.js';
import { U } from './Uniforms.js';

const _p = new Vector3(), _l = new Vector3(), _r = new Vector3(), _v = new Vector3();

export class Effects {
	constructor( scene, quality ) {
		this.scene = scene;
		this.group = new Group(); this.group.name = 'effects';
		scene.add( this.group );
		const m = quality.particles ?? 1;
		this.pools = {
			smoke: new ParticlePool( 'smoke', Math.floor( 1800 * m ) + 200 ),
			dust: new ParticlePool( 'dust', Math.floor( 1400 * m ) + 200 ),
			grass: new ParticlePool( 'grass', Math.floor( 700 * m ) + 100 ),
			spray: new ParticlePool( 'spray', Math.floor( 1800 * m ) + 200 ),
			spark: new ParticlePool( 'spark', Math.floor( 1200 * m ) + 100 ),
			debris: new ParticlePool( 'debris', Math.floor( 300 * m ) + 50 ),
			flame: new ParticlePool( 'flame', 120 )
		};
		for ( const k in this.pools ) this.group.add( this.pools[ k ].mesh );
		this.rain = new RainSystem( Math.floor( 5000 * m ) + 500 );
		this.group.add( this.rain.mesh );
		this.skids = new SkidMarks( quality.skidMarks ?? 3000 );
		this.group.add( this.skids.mesh );
		this.rng = makeRNG( 42 );
		this.time = 0;
		this.wheelState = new Map(); // wheel → { pl, pr, had }
		this.budget = m;
	}

	setQualityScale( m ) { this.budget = m; }

	/** Called from the fixed step with the list of car records ({vehicle, uniforms,...}). */
	update( dt, cars, now ) {
		this.time = now;
		const rng = this.rng;
		const wet = U.wetness.value;
		for ( const car of cars ) {
			const v = car.vehicle;
			const speed = v.speed;
			for ( let i = 0; i < 4; i ++ ) {
				const w = v.wheels[ i ];
				let st = this.wheelState.get( w );
				if ( ! st ) { st = { pl: new Vector3(), pr: new Vector3(), had: false, acc: 0 }; this.wheelState.set( w, st ); }
				if ( ! w.onGround ) { st.had = false; continue; }
				const c = w.contact;
				const slipVel = Math.abs( w.slipVel ) + Math.abs( Math.tan( w.slipAngle ) * Math.max( 1, Math.abs( v.localVel.z ) ) );
				const skid = w.skid;
				// --- tyre marks on asphalt/concrete when skidding
				if ( ( w.surface === SURFACE.ASPHALT || w.surface === SURFACE.CONCRETE || w.surface === SURFACE.KERB ) && skid > 0.18 && speed > 1 ) {
					_l.copy( c ).addScaledVector( w.lat, v.def.wheelWidth * 0.5 ).addScaledVector( w.normal, 0.012 );
					_r.copy( c ).addScaledVector( w.lat, - v.def.wheelWidth * 0.5 ).addScaledVector( w.normal, 0.012 );
					if ( st.had && st.pl.distanceToSquared( _l ) > 0.04 && st.pl.distanceToSquared( _l ) < 9 ) {
						this.skids.addQuad( st.pl, st.pr, _l, _r, clamp( skid * 1.2, 0, 1 ) * ( 1 - wet * 0.5 ), now );
						st.pl.copy( _l ); st.pr.copy( _r );
					} else if ( ! st.had || st.pl.distanceToSquared( _l ) >= 9 ) { st.pl.copy( _l ); st.pr.copy( _r ); }
					st.had = true;
				} else st.had = false;
				// --- particle emission rates (particles per second)
				const groundY = c.y;
				const emit = ( pool, rate, fn ) => {
					st.acc += rate * dt * this.budget;
					while ( st.acc >= 1 ) { st.acc -= 1; fn( pool ); }
				};
				if ( w.surface === SURFACE.ASPHALT || w.surface === SURFACE.CONCRETE || w.surface === SURFACE.KERB ) {
					if ( wet > 0.15 && speed > 6 ) {
						emit( this.pools.spray, clamp( speed * 1.2, 0, 60 ) * wet, ( pool ) => {
							_v.copy( v.velocity ).multiplyScalar( - 0.25 ).addScaledVector( w.lat, ( rng() - 0.5 ) * 2 ); _v.y += 1.5 + rng() * 2;
							pool.spawn( now, c.x + ( rng() - 0.5 ) * 0.3, c.y + 0.1, c.z + ( rng() - 0.5 ) * 0.3, _v.x, _v.y, _v.z, 0.5 + rng() * 0.4, 0.25 + rng() * 0.35, rng(), 0, groundY );
						} );
					}
					if ( skid > 0.22 && slipVel > 1.5 ) {
						const rate = clamp( skid * 70 * ( 1 - wet * 0.7 ), 0, 90 );
						emit( this.pools.smoke, rate, ( pool ) => {
							_v.copy( v.velocity ).multiplyScalar( 0.15 ).addScaledVector( w.lat, ( rng() - 0.5 ) * 3 ); _v.y += 0.8 + rng() * 1.2;
							pool.spawn( now, c.x + ( rng() - 0.5 ) * 0.4, c.y + 0.15, c.z + ( rng() - 0.5 ) * 0.4, _v.x, _v.y, _v.z, 1.2 + rng() * 1.6, 0.5 + rng() * 0.5, rng(), skid * 0.5, groundY );
						} );
					}
				} else if ( w.surface === SURFACE.GRAVEL || w.surface === SURFACE.SAND ) {
					if ( speed > 3 ) {
						emit( this.pools.dust, clamp( speed * 2 + skid * 40, 0, 80 ), ( pool ) => {
							_v.copy( v.velocity ).multiplyScalar( - 0.2 ).addScaledVector( w.lat, ( rng() - 0.5 ) * 4 ); _v.y += 1 + rng() * 2;
							pool.spawn( now, c.x, c.y + 0.1, c.z, _v.x, _v.y, _v.z, 1.5 + rng() * 1.5, 0.6 + rng() * 0.8, rng(), 0, groundY );
						} );
						emit( this.pools.debris, clamp( speed * 0.3 + skid * 10, 0, 20 ), ( pool ) => {
							_v.copy( v.velocity ).multiplyScalar( - 0.35 ).addScaledVector( w.lat, ( rng() - 0.5 ) * 3 ); _v.y += 2 + rng() * 4;
							pool.spawn( now, c.x, c.y + 0.1, c.z, _v.x, _v.y, _v.z, 0.8 + rng() * 0.6, 0.03 + rng() * 0.03, rng(), 0.3, groundY );
						} );
					}
				} else if ( w.surface === SURFACE.GRASS ) {
					if ( speed > 3 ) {
						emit( this.pools.grass, clamp( speed * 1.5 + skid * 30, 0, 60 ), ( pool ) => {
							_v.copy( v.velocity ).multiplyScalar( - 0.3 ).addScaledVector( w.lat, ( rng() - 0.5 ) * 3 ); _v.y += 2 + rng() * 3;
							pool.spawn( now, c.x, c.y + 0.1, c.z, _v.x, _v.y, _v.z, 0.7 + rng() * 0.6, 0.05 + rng() * 0.06, rng(), 0, groundY );
						} );
						emit( this.pools.dust, clamp( speed * 0.8, 0, 30 ), ( pool ) => {
							_v.copy( v.velocity ).multiplyScalar( - 0.15 ); _v.y += 1 + rng();
							pool.spawn( now, c.x, c.y + 0.1, c.z, _v.x, _v.y, _v.z, 1.2 + rng(), 0.5 + rng() * 0.5, rng(), 0.2, groundY );
						} );
					}
				}
				// bottoming out → sparks from the underbody
				if ( w.compression > v.def.suspension.rest * 0.95 && speed > 15 ) {
					for ( let k = 0; k < 4; k ++ ) {
						_v.copy( v.velocity ).multiplyScalar( 0.4 ).addScaledVector( w.lat, ( rng() - 0.5 ) * 4 ); _v.y += rng() * 2;
						this.pools.spark.spawn( now, c.x, c.y + 0.05, c.z, _v.x, _v.y, _v.z, 0.3 + rng() * 0.4, 0.02 + rng() * 0.02, rng(), 0, groundY );
					}
				}
			}
			// --- collisions: sparks + debris at the contact point
			for ( const col of v.collisions ) {
				const n = Math.floor( 20 + col.strength * 80 );
				for ( let k = 0; k < n; k ++ ) {
					_v.copy( col.normal ).multiplyScalar( 2 + rng() * 6 ).addScaledVector( v.velocity, 0.3 );
					_v.x += ( rng() - 0.5 ) * 6; _v.y += rng() * 4; _v.z += ( rng() - 0.5 ) * 6;
					this.pools.spark.spawn( now, col.point.x, col.point.y, col.point.z, _v.x, _v.y, _v.z, 0.3 + rng() * 0.6, 0.02 + rng() * 0.03, rng(), 0, col.point.y - 0.5 );
				}
				for ( let k = 0; k < Math.floor( col.strength * 12 ); k ++ ) {
					_v.copy( col.normal ).multiplyScalar( 1 + rng() * 4 ); _v.y += 2 + rng() * 3;
					this.pools.debris.spawn( now, col.point.x, col.point.y, col.point.z, _v.x, _v.y, _v.z, 1 + rng(), 0.04 + rng() * 0.06, rng(), 0.6, col.point.y - 0.5 );
				}
			}
			// --- exhaust flames: throttle lift above 70% rpm, or on upshift
			const eng = v.engine;
			const liftOff = ( car._prevThrottle ?? 0 ) > 0.6 && v.controls.throttle < 0.2 && eng.rpm > v.def.engine.redline * 0.65;
			const shift = eng.shiftTimer > 0.16;
			if ( ( liftOff || shift ) && rng() < 0.6 ) {
				const tail = v.def.stations[ 0 ];
				const xs = v.def.exhaust === 'centre' ? [ - 0.08, 0.08 ] : v.def.exhaust === 'quad' ? [ - 0.55, - 0.42, 0.42, 0.55 ] : [ - 0.45, 0.45 ];
				for ( const x of xs ) {
					_p.set( x, tail.floor + 0.06 - v.def.cgHeight, tail.z - 0.05 ).applyQuaternion( v.quaternion ).add( v.position );
					for ( let k = 0; k < 3; k ++ ) {
						_v.copy( v.forward ).multiplyScalar( - 6 - rng() * 4 ).add( v.velocity );
						this.pools.flame.spawn( now, _p.x, _p.y, _p.z, _v.x, _v.y, _v.z, 0.08 + rng() * 0.08, 0.12 + rng() * 0.12, rng(), 0, _p.y - 1 );
					}
				}
			}
			car._prevThrottle = v.controls.throttle;
		}
	}

	/** Upload buffers once per rendered frame. */
	flush() {
		for ( const k in this.pools ) this.pools[ k ].flush();
		this.skids.flush();
	}

	dispose() {
		this.scene.remove( this.group );
		this.group.traverse( ( o ) => { o.geometry?.dispose(); o.material?.dispose?.(); } );
	}
}
