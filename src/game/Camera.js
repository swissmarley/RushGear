/**
 * Race cameras: cinematic chase (spring-damped, speed-aware FOV), hood, onboard,
 * plus a trackside/replay mode. Includes motion & collision shake.
 */
import { PerspectiveCamera, Vector3, Quaternion, MathUtils } from 'three/webgpu';
import { damp, clamp, lerp } from '../core/math.js';

const _p = new Vector3(), _q = new Quaternion(), _t = new Vector3(), _f = new Vector3(), _u = new Vector3(), _l = new Vector3();

export const CAMERA_MODES = [ 'chase', 'chase-far', 'hood', 'onboard' ];

export class RaceCamera {
	constructor( aspect ) {
		this.camera = new PerspectiveCamera( 62, aspect, 0.15, 6000 );
		this.mode = 0;
		this.pos = new Vector3();
		this.look = new Vector3();
		this.vel = new Vector3();
		this.shake = 0;
		this.shakeSeed = Math.random() * 100;
		this.fov = 62;
		this.target = null; // Vehicle
		this.replay = false;
		this.replayPos = new Vector3();
		this.trackPositions = [];
		this.lastTracksideIndex = - 1;
		this.initialised = false;
		this.headingSmooth = new Vector3( 0, 0, 1 );
	}

	setMode( m ) { this.mode = ( ( m % CAMERA_MODES.length ) + CAMERA_MODES.length ) % CAMERA_MODES.length; this.initialised = false; }
	cycle() { this.setMode( this.mode + 1 ); }
	addShake( s ) { this.shake = Math.min( 1.5, this.shake + s ); }

	update( dt, carPos, carQuat, vehicle, time ) {
		const cam = this.camera;
		this.target = vehicle;
		_f.set( 0, 0, 1 ).applyQuaternion( carQuat );
		_u.set( 0, 1, 0 ).applyQuaternion( carQuat );
		_l.set( 1, 0, 0 ).applyQuaternion( carQuat );
		const speed = vehicle ? vehicle.speed : 0;
		const mode = CAMERA_MODES[ this.mode ];
		this.shake = Math.max( 0, this.shake - dt * 2.5 );

		if ( this.replay ) {
			this._trackside( dt, carPos, vehicle );
			return;
		}

		if ( mode === 'chase' || mode === 'chase-far' ) {
			const far = mode === 'chase-far';
			// heading blends the car's nose with its velocity direction so drifts read on screen
			const velDir = _t.copy( vehicle.velocity ); velDir.y = 0;
			let blend = clamp( ( speed - 3 ) / 12, 0, 0.6 );
			if ( vehicle.engine.gear === - 1 ) blend = 0;
			if ( velDir.lengthSq() > 0.5 ) velDir.normalize(); else { velDir.copy( _f ); blend = 0; }
			const head = _p.copy( _f ); head.y = 0; head.normalize().lerp( velDir, blend ).normalize();
			this.headingSmooth.lerp( head, 1 - Math.exp( - 6 * dt ) ).normalize();
			const dist = ( far ? 8.0 : 6.4 ) + speed * 0.03;
			const height = ( far ? 2.6 : 1.9 ) + speed * 0.005;
			const desired = _t.copy( carPos ).addScaledVector( this.headingSmooth, - dist );
			desired.y = carPos.y + height;
			if ( ! this.initialised ) { this.pos.copy( desired ); this.initialised = true; }
			// critically damped follow; stiffer laterally than longitudinally for a weighty feel
			const lambda = 9 + speed * 0.05;
			this.pos.x = damp( this.pos.x, desired.x, lambda, dt );
			this.pos.z = damp( this.pos.z, desired.z, lambda, dt );
			this.pos.y = damp( this.pos.y, desired.y, 7, dt );
			// keep the camera above the ground
			const groundY = vehicle.track.project( this.pos.x, this.pos.z, vehicle.trackHint, this._gp || ( this._gp = {} ) ).height;
			if ( this.pos.y < groundY + 0.6 ) this.pos.y = groundY + 0.6;
			const lookTarget = _t.copy( carPos ).addScaledVector( this.headingSmooth, 2.5 + speed * 0.03 ); lookTarget.y += 0.5;
			this.look.lerp( lookTarget, 1 - Math.exp( - 14 * dt ) );
			cam.position.copy( this.pos );
			cam.up.set( 0, 1, 0 ).lerp( _u, 0.15 ).normalize();
			cam.lookAt( this.look );
			this.fov = damp( this.fov, ( far ? 55 : 60 ) + clamp( speed / 80, 0, 1 ) * 18, 4, dt );
		} else if ( mode === 'hood' ) {
			cam.position.copy( carPos ).addScaledVector( _f, 1.2 ).addScaledVector( _u, 0.55 );
			cam.quaternion.copy( carQuat );
			// three cameras look down -Z; our cars face +Z, so turn around
			_q.setFromAxisAngle( _u.set( 0, 1, 0 ), Math.PI );
			cam.quaternion.multiply( _q );
			this.fov = damp( this.fov, 70 + clamp( speed / 80, 0, 1 ) * 12, 4, dt );
		} else { // onboard
			cam.position.copy( carPos ).addScaledVector( _f, - 0.35 ).addScaledVector( _u, 0.62 ).addScaledVector( _l, 0.36 );
			cam.quaternion.copy( carQuat );
			_q.setFromAxisAngle( _u.set( 0, 1, 0 ), Math.PI );
			cam.quaternion.multiply( _q );
			// subtle head lean in corners
			_q.setFromAxisAngle( _u.set( 0, 0, 1 ), clamp( vehicle.lateralG * 0.015, - 0.03, 0.03 ) );
			cam.quaternion.multiply( _q );
			this.fov = damp( this.fov, 74 + clamp( speed / 80, 0, 1 ) * 10, 4, dt );
		}

		// --- shake: collisions + speed rumble + kerbs/off-road
		let rumble = 0;
		if ( vehicle ) for ( const w of vehicle.wheels ) if ( w.onGround && w.surface !== 0 ) rumble += 0.004 * clamp( speed / 20, 0, 1 );
		const amt = this.shake * 0.12 + rumble + clamp( speed / 90, 0, 1 ) * 0.004;
		if ( amt > 0.0005 ) {
			const t = time * 37 + this.shakeSeed;
			cam.position.x += Math.sin( t * 1.7 ) * amt; cam.position.y += Math.cos( t * 2.3 ) * amt * 0.7; cam.position.z += Math.sin( t * 1.1 + 2 ) * amt;
			_q.setFromAxisAngle( _u.set( 0, 0, 1 ), Math.sin( t * 2.9 ) * amt * 0.25 );
			cam.quaternion.multiply( _q );
		}
		cam.fov = this.fov;
		cam.updateProjectionMatrix();
	}

	/** Replay / trackside cameras: pick a fixed vantage point near the car and track it. */
	setTracksideCameras( track ) {
		const list = [];
		const S = track.samples, N = S.length;
		for ( let i = 0; i < N; i += 60 ) {
			const sm = S[ i ];
			const side = sm.curvature > 0 ? 1 : - 1; // outside of the corner
			const p = sm.pos.clone().addScaledVector( sm.right, side * ( sm.width / 2 + 9 + Math.abs( i % 7 ) ) ).addScaledVector( sm.up, 3 + ( i % 3 ) * 2 );
			list.push( { pos: p, s: sm.s } );
		}
		this.trackPositions = list;
		this._track = track;
	}

	_trackside( dt, carPos, vehicle ) {
		const cam = this.camera;
		const s = vehicle.proj?.s ?? 0;
		const L = this._track.length;
		// choose the camera just ahead of the car; switch when it passes
		let best = 0, bestD = Infinity;
		for ( let i = 0; i < this.trackPositions.length; i ++ ) {
			let d = this.trackPositions[ i ].s - s; if ( d < - 15 ) d += L;
			if ( d >= - 15 && d < bestD ) { bestD = d; best = i; }
		}
		if ( best !== this.lastTracksideIndex ) { this.lastTracksideIndex = best; this.fov = 40; }
		const cp = this.trackPositions[ best ].pos;
		cam.position.copy( cp );
		this.look.lerp( carPos, 1 - Math.exp( - 10 * dt ) );
		cam.up.set( 0, 1, 0 );
		cam.lookAt( this.look );
		const dist = cp.distanceTo( carPos );
		this.fov = damp( this.fov, clamp( 1600 / dist, 18, 50 ), 3, dt );
		cam.fov = this.fov;
		cam.updateProjectionMatrix();
	}

	resize( aspect ) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
}
