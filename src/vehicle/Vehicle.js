/**
 * Vehicle — rigid-body car simulation at a fixed 120 Hz step.
 *
 *  • 6-DOF rigid body (semi-implicit Euler, body-space inertia tensor)
 *  • 4 raycast struts against the analytic track surface (no mesh raycasts)
 *  • combined-slip tyre model (Pacejka-style curves + friction ellipse + load sensitivity)
 *  • per-wheel rotational dynamics → real wheelspin / lock-ups, ABS + traction control
 *  • engine torque curve, rev limiter, automatic/manual gearbox, engine braking
 *  • aero drag + downforce, rolling resistance, surface drag (grass/gravel/sand)
 *  • wall collisions against the track's lateral limits, car-to-car OBB collisions
 *
 * Car-local axes: +z forward, +y up, +x left.
 */
import { Vector3, Quaternion, Matrix3 } from 'three/webgpu';
import { clamp, lerp, damp } from '../core/math.js';
import { SURFACE } from '../world/Track.js';

export const DT = 1 / 120;
const G = 9.81;
const _up = new Vector3( 0, 1, 0 );
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _d = new Vector3(), _e = new Vector3(), _f = new Vector3();
const _q = new Quaternion();
const _wq = new Quaternion();

// Surface grip & drag
const SURF = {
	[ SURFACE.ASPHALT ]: { mu: 1.0, drag: 0, roll: 0.012, wetMu: 0.72 },
	[ SURFACE.KERB ]: { mu: 0.88, drag: 0, roll: 0.02, wetMu: 0.6 },
	[ SURFACE.GRASS ]: { mu: 0.5, drag: 1.4, roll: 0.06, wetMu: 0.38 },
	[ SURFACE.GRAVEL ]: { mu: 0.62, drag: 2.6, roll: 0.08, wetMu: 0.55 },
	[ SURFACE.SAND ]: { mu: 0.55, drag: 3.5, roll: 0.1, wetMu: 0.55 },
	[ SURFACE.CONCRETE ]: { mu: 0.92, drag: 0, roll: 0.015, wetMu: 0.68 }
};

// Pacejka "magic formula" (normalised, peak ≈ 1)
const magic = ( x, B, C, E ) => Math.sin( C * Math.atan( B * x - E * ( B * x - Math.atan( B * x ) ) ) );

export class Vehicle {
	constructor( def, track, opts = {} ) {
		this.def = def;
		this.track = track;
		this.id = opts.id ?? 0;
		this.name = opts.name ?? 'Player';
		this.isPlayer = !! opts.isPlayer;

		this.mass = def.mass;
		this.invMass = 1 / def.mass;
		const L = 4.6, W = 1.9, H = 1.2;
		this.inertia = new Vector3( this.mass / 12 * ( H * H + L * L ), this.mass / 12 * ( W * W + L * L ), this.mass / 12 * ( W * W + H * H ) );
		this.invInertia = new Vector3( 1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z );

		this.position = new Vector3();
		this.quaternion = new Quaternion();
		this.velocity = new Vector3();
		this.angularVelocity = new Vector3();
		this.prevPosition = new Vector3();
		this.prevQuaternion = new Quaternion();
		this.forward = new Vector3( 0, 0, 1 );
		this.up = new Vector3( 0, 1, 0 );
		this.left = new Vector3( 1, 0, 0 );

		this.controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, gearUp: false, gearDown: false };
		this.aids = { abs: true, tc: true, autoGear: true };
		this.steerAngle = 0;
		this.engine = { rpm: def.engine.idle, gear: 1, shiftTimer: 0, torque: 0, load: 0, limiter: 0 };
		this.speed = 0; this.speedKmh = 0; this.localVel = new Vector3();
		this.lateralG = 0; this.longG = 0;
		this.damage = 0;
		this.collisions = []; // events this step: {point, strength, normal}
		this.trackHint = 0;
		this.proj = {};     // last projection of the CG onto the track
		this.onTrackLateral = 0;
		this.airTime = 0;
		this.reverseTimer = 0;
		this.hitCooldown = 0;

		const s = def.suspension;
		const staticComp = ( this.mass * G / 4 ) / s.k;
		const attachY = - def.cgHeight + def.wheelRadius + ( s.rest - staticComp );
		const axleF = def.wheels.front + def.wheels.axleOffset, axleR = def.wheels.rear + def.wheels.axleOffset;
		const drive = def.drivetrain;
		this.wheels = [
			{ local: new Vector3( def.trackF / 2, attachY, axleF ), front: true, side: 1 },
			{ local: new Vector3( - def.trackF / 2, attachY, axleF ), front: true, side: - 1 },
			{ local: new Vector3( def.trackR / 2, attachY, axleR ), front: false, side: 1 },
			{ local: new Vector3( - def.trackR / 2, attachY, axleR ), front: false, side: - 1 }
		];
		for ( const w of this.wheels ) {
			Object.assign( w, {
				radius: def.wheelRadius, inertia: 1.1,
				driven: drive === 'AWD' || ( drive === 'RWD' && ! w.front ) || ( drive === 'FWD' && w.front ),
				compression: staticComp, prevCompression: staticComp, onGround: false,
				angVel: 0, spinAngle: 0, slipRatio: 0, slipAngle: 0, load: 0, surface: SURFACE.ASPHALT,
				skid: 0, fx: 0, fy: 0, slipVel: 0,
				contact: new Vector3(), hub: new Vector3(), normal: new Vector3( 0, 1, 0 ), fwd: new Vector3(), lat: new Vector3(),
				world: new Vector3(), absActive: false, tcActive: false, proj: {}
			} );
		}
		this.cornerPoints = [
			new Vector3( 0.95, 0, 2.3 ), new Vector3( - 0.95, 0, 2.3 ), new Vector3( 0.95, 0, - 2.3 ), new Vector3( - 0.95, 0, - 2.3 ),
			new Vector3( 0.98, 0, 0 ), new Vector3( - 0.98, 0, 0 )
		];
		this.halfWidth = 0.97; this.halfLength = 2.35;
		this.wetness = 0; // set from weather each step
	}

	/* ------------------------------------------------------------------------------------------ */

	reset( x, y, z, heading, quaternion = null ) {
		this.position.set( x, y + this.def.cgHeight + 0.02, z );
		if ( quaternion ) this.quaternion.copy( quaternion ); else this.quaternion.setFromAxisAngle( _up, heading );
		this.velocity.set( 0, 0, 0 );
		this.angularVelocity.set( 0, 0, 0 );
		this.prevPosition.copy( this.position );
		this.prevQuaternion.copy( this.quaternion );
		this.engine.rpm = this.def.engine.idle; this.engine.gear = 1; this.engine.shiftTimer = 0;
		const staticComp = ( this.mass * G / 4 ) / this.def.suspension.k;
		for ( const w of this.wheels ) { w.angVel = 0; w.compression = w.prevCompression = staticComp; w.skid = 0; }
		this.steerAngle = 0; this.damage = 0; this.airTime = 0;
		this.trackHint = this.track.nearestIndex( x, z );
		this.updateAxes();
		this.track.project( x, z, this.trackHint, this.proj );
		this.trackHint = this.proj.index;
	}

	updateAxes() {
		this.forward.set( 0, 0, 1 ).applyQuaternion( this.quaternion );
		this.up.set( 0, 1, 0 ).applyQuaternion( this.quaternion );
		this.left.set( 1, 0, 0 ).applyQuaternion( this.quaternion );
	}

	engineTorqueAt( rpm, throttle ) {
		const e = this.def.engine;
		const x = rpm / e.peakRpm;
		let f;
		if ( x < 1 ) { const t = clamp( ( rpm - e.idle * 0.5 ) / ( e.peakRpm - e.idle * 0.5 ), 0, 1 ); f = 0.5 + 0.5 * ( t * t * ( 3 - 2 * t ) ); }
		else { const t = ( x - 1 ) / ( e.redline / e.peakRpm - 1 ); f = 1 - 0.28 * t * t; }
		const drive = e.maxTorque * f * throttle;
		const brakeT = - 0.07 * e.maxTorque * ( rpm / e.redline ) * ( 1 - throttle );
		return drive + brakeT;
	}

	/* ------------------------------------------------------------------------------------------ */

	step( dt, env = {} ) {
		const def = this.def, c = this.controls, eng = this.engine;
		this.prevPosition.copy( this.position );
		this.prevQuaternion.copy( this.quaternion );
		this.collisions.length = 0;
		this.wetness = env.wetness ?? 0;
		this.hitCooldown = Math.max( 0, this.hitCooldown - dt );
		this.updateAxes();

		// --- local velocity & helpers
		_a.copy( this.velocity );
		this.localVel.set( _a.dot( this.left ), _a.dot( this.up ), _a.dot( this.forward ) );
		const vLong = this.localVel.z;
		this.speed = this.velocity.length();
		this.speedKmh = this.speed * 3.6;

		// --- steering: speed-sensitive ratio and rate limit
		const steerMax = def.steerMax * ( 1 / ( 1 + Math.abs( vLong ) * 0.045 ) );
		const targetSteer = - c.steer * steerMax; // +x is left, so right (steer>0) is a negative yaw
		this.steerAngle = damp( this.steerAngle, targetSteer, 18, dt );

		// --- gearbox
		this._gearbox( dt, vLong );
		const inReverse = eng.gear === - 1;
		let throttle = inReverse ? c.brake : c.throttle;
		let brake = inReverse ? c.throttle : c.brake;
		if ( eng.shiftTimer > 0 ) throttle *= 0.1;

		// --- engine rpm from driven wheels (clutch engaged) with idle floor
		const ratio = ( inReverse ? - 3.3 : def.gears[ eng.gear - 1 ] ) * def.finalDrive;
		let avgDrivenW = 0, nDriven = 0;
		for ( const w of this.wheels ) if ( w.driven ) { avgDrivenW += w.angVel; nDriven ++; }
		avgDrivenW /= Math.max( 1, nDriven );
		const wheelRpm = avgDrivenW * ratio * 60 / ( 2 * Math.PI );
		const targetRpm = Math.max( def.engine.idle, wheelRpm );
		eng.rpm = damp( eng.rpm, targetRpm, 40, dt );
		eng.limiter = Math.max( 0, eng.limiter - dt );
		if ( eng.rpm > def.engine.redline ) { eng.limiter = 0.05; }
		if ( eng.limiter > 0 ) throttle = 0;
		// traction control: cut throttle when driven wheels spin
		if ( this.aids.tc ) {
			let maxSlip = 0;
			for ( const w of this.wheels ) if ( w.driven && w.onGround ) maxSlip = Math.max( maxSlip, w.slipRatio );
			const tcTarget = clamp( ( maxSlip - 0.12 ) / 0.15, 0, 0.85 );
			// smoothed so the intervention is a gentle torque trim rather than a 120 Hz bang-bang
			this.tcLevel = damp( this.tcLevel || 0, tcTarget, tcTarget > ( this.tcLevel || 0 ) ? 60 : 12, dt );
			throttle *= 1 - this.tcLevel;
			for ( const w of this.wheels ) w.tcActive = this.tcLevel > 0.1 && w.driven;
		}
		const engineTorque = this.engineTorqueAt( eng.rpm, throttle );
		eng.torque = engineTorque; eng.load = throttle;
		const wheelTorqueTotal = engineTorque * ratio * 0.9;
		const perWheelDrive = wheelTorqueTotal / Math.max( 1, nDriven );

		// --- accumulate forces/torques (world)
		const F = _d.set( 0, 0, 0 ), T = _e.set( 0, 0, 0 );
		F.y -= this.mass * G;

		// suspension & tyres
		const s = def.suspension;
		const down = _f.copy( this.up ).negate();
		let groundedCount = 0;
		for ( let i = 0; i < 4; i ++ ) {
			const w = this.wheels[ i ];
			const A = w.world.copy( w.local ).applyQuaternion( this.quaternion ).add( this.position );
			// --- strut ray vs analytic ground: iterate the plane intersection twice
			let t = s.rest + w.radius;
			let gx = A.x, gz = A.z;
			let proj = w.proj;
			for ( let it = 0; it < 2; it ++ ) {
				this.track.project( gx, gz, this.trackHint, proj );
				const nx = proj.nx, ny = proj.ny, nz = proj.nz;
				const num = nx * ( A.x - gx ) + ny * ( A.y - proj.height ) + nz * ( A.z - gz );
				const den = nx * down.x + ny * down.y + nz * down.z;
				if ( den < - 1e-4 ) t = - num / den; else t = s.rest + w.radius + 1;
				gx = A.x + down.x * t; gz = A.z + down.z * t;
			}
			const maxLen = s.rest + w.radius;
			w.onGround = t <= maxLen && t > 0;
			w.surface = proj.surface;
			w.normal.set( proj.nx, proj.ny, proj.nz );
			w.prevCompression = w.compression;
			if ( ! w.onGround ) {
				w.compression = 0; w.load = 0; w.skid = 0; w.fx = w.fy = 0; w.slipRatio = 0; w.slipAngle = 0;
				w.hub.copy( A ).addScaledVector( down, s.rest );
				// free-spinning wheel: engine still drives it, air drag slows it
				const torque = ( w.driven ? perWheelDrive : 0 ) - Math.sign( w.angVel ) * brake * def.brakes.maxTorque * ( w.front ? def.brakes.bias : 1 - def.brakes.bias );
				w.angVel += torque / w.inertia * dt;
				w.angVel *= 0.995;
				continue;
			}
			groundedCount ++;
			w.compression = clamp( maxLen - t, 0, s.rest );
			w.contact.copy( A ).addScaledVector( down, t );
			w.hub.copy( A ).addScaledVector( down, t - w.radius );
			const compVel = clamp( ( w.compression - w.prevCompression ) / dt, - 4, 4 );
			// spring + damper + anti-roll bar + bump stop
			const other = this.wheels[ i ^ 1 ];
			const arb = ( w.front ? s.arbF : s.arbR ) * ( w.compression - other.compression );
			let springF = s.k * w.compression + s.c * compVel + arb;
			if ( w.compression > s.rest * 0.92 ) springF += ( w.compression - s.rest * 0.92 ) * s.k * 6;
			springF = Math.max( 0, springF );
			w.load = springF;
			// apply along strut (body up) at the attach point
			_a.copy( this.up ).multiplyScalar( springF );
			F.add( _a );
			_b.subVectors( A, this.position );
			T.add( _c.crossVectors( _b, _a ) );

			// --- tyre forces at the contact patch
			const steer = w.front ? this.steerAngle : 0;
			// wheel forward in world: rotate body forward around body up by steer, then flatten onto the contact plane
			_wq.setFromAxisAngle( this.up, steer );
			w.fwd.copy( this.forward ).applyQuaternion( _wq );
			w.fwd.addScaledVector( w.normal, - w.fwd.dot( w.normal ) ).normalize();
			w.lat.crossVectors( w.normal, w.fwd ).normalize(); // points left
			// contact velocity = v + ω × r
			_b.subVectors( w.contact, this.position );
			_a.crossVectors( this.angularVelocity, _b ).add( this.velocity );
			const vl = _a.dot( w.fwd ), vt = _a.dot( w.lat );
			const surf = SURF[ w.surface ] || SURF[ SURFACE.ASPHALT ];
			const muBase = lerp( surf.mu, surf.wetMu, this.wetness ) * def.tyres.grip;
			const loadSens = clamp( 1.12 - 0.00003 * w.load, 0.8, 1.12 );
			const mu = muBase * loadSens;

			// slip quantities
			const vAbs = Math.max( Math.abs( vl ), 0.8 );
			w.slipAngle = Math.atan2( vt, vAbs );
			const stiff = def.tyres.stiffness;
			const maxF = mu * w.load;
			const fyRaw = - mu * w.load * magic( w.slipAngle, 11 * stiff, 1.45, - 0.3 );
			const r = w.radius;
			// longitudinal force as a function of wheel speed (friction ellipse with the lateral demand)
			const fxOf = ( om ) => {
				const sr = ( om * r - vl ) / vAbs;
				let f = mu * w.load * magic( sr, 10 * stiff, 1.9, 0.97 );
				const tot = Math.hypot( f, fyRaw );
				if ( tot > maxF ) f *= maxF / tot;
				return f;
			};
			// --- wheel rotation: implicit Euler solved with a bracketed (safeguarded) Newton method.
			// The tyre's longitudinal stiffness makes the explicit ODE unstable at 120 Hz; the implicit
			// solve is unconditionally stable, so launches, wheelspin and lock-ups all behave.
			let brakeT = brake * def.brakes.maxTorque * ( w.front ? def.brakes.bias : 1 - def.brakes.bias );
			if ( c.handbrake > 0 && ! w.front ) brakeT = Math.max( brakeT, def.brakes.maxTorque * 1.5 );
			w.absActive = false;
			if ( this.aids.abs && brake > 0 && w.slipRatio < - 0.22 && ! ( c.handbrake > 0 && ! w.front ) ) { brakeT *= 0.25; w.absActive = true; }
			const driveT = w.driven ? perWheelDrive : 0;
			const BW = 0.4; // brake torque ramps to full over ±0.4 rad/s (smooth static friction)
			const om0 = w.angVel, kI = dt / w.inertia;
			const g = ( om ) => om - om0 - kI * ( driveT - brakeT * clamp( om / BW, - 1, 1 ) - fxOf( om ) * r );
			const M = kI * ( Math.abs( driveT ) + brakeT + maxF * r ) + 1e-3;
			let lo = om0 - M, hi = om0 + M, om = om0;
			for ( let k = 0; k < 16; k ++ ) {
				const res = g( om );
				if ( Math.abs( res ) < 1e-5 ) break;
				if ( res > 0 ) hi = om; else lo = om;
				const h = 0.02;
				const d = ( g( om + h ) - g( om - h ) ) / ( 2 * h );
				let next = d > 1e-6 ? om - res / d : ( lo + hi ) * 0.5;
				if ( next <= lo || next >= hi ) next = ( lo + hi ) * 0.5; // Newton left the bracket → bisect
				om = next;
			}
			w.angVel = om;
			let fx = fxOf( om );
			let fy = fyRaw;
			const tot = Math.hypot( fx, fy );
			if ( tot > maxF ) { fy *= maxF / tot; }
			const slipVel = om * r - vl;
			w.slipVel = slipVel;
			w.slipRatio = clamp( slipVel / vAbs, - 1.5, 1.5 );
			// stability clamp: lateral force may not reverse the lateral slip within one step
			const fyCap = Math.abs( vt ) * ( this.mass * 0.3 ) / dt;
			fy = clamp( fy, - fyCap, fyCap );
			// rolling resistance & surface drag (sinking into grass/gravel)
			const roll = - Math.sign( vl ) * surf.roll * w.load * clamp( Math.abs( vl ) / 0.5, 0, 1 );
			const surfDrag = - vl * surf.drag * this.mass * 0.25 * 0.05;
			w.fx = fx; w.fy = fy;
			_a.copy( w.fwd ).multiplyScalar( fx + roll + surfDrag ).addScaledVector( w.lat, fy );
			F.add( _a );
			T.add( _c.crossVectors( _b, _a ) );

			// skid intensity for audio / smoke / marks
			const slipMag = Math.hypot( w.slipRatio * 2.2, w.slipAngle * 5.0 );
			w.skid = clamp( ( slipMag - 0.6 ) * 1.3, 0, 1 ) * clamp( w.load / 2500, 0, 1 );
		}
		// limited-slip style viscous coupling between driven wheels on an axle
		for ( const [ a, b ] of [ [ 0, 1 ], [ 2, 3 ] ] ) {
			const wa = this.wheels[ a ], wb = this.wheels[ b ];
			if ( ! wa.driven ) continue;
			const dOm = ( wa.angVel - wb.angVel ) * Math.min( 0.5, 25 * dt );
			wa.angVel -= dOm * 0.5; wb.angVel += dOm * 0.5;
		}
		this.airTime = groundedCount === 0 ? this.airTime + dt : 0;
		for ( const w of this.wheels ) w.spinAngle = ( w.spinAngle + w.angVel * dt ) % ( Math.PI * 2 );

		// --- aero
		const v2 = this.speed * this.speed;
		if ( this.speed > 0.1 ) {
			const drag = 0.5 * 1.225 * def.aero.cd * def.aero.area * v2;
			F.addScaledVector( _a.copy( this.velocity ).normalize(), - drag );
		}
		const vf2 = Math.max( 0, vLong ) ** 2;
		const df = 0.5 * 1.225 * def.aero.downforce * vf2;
		const axleF = def.wheels.front + def.wheels.axleOffset, axleR = def.wheels.rear + def.wheels.axleOffset;
		_a.copy( this.up ).multiplyScalar( - df * def.aero.balance );
		_b.copy( this.forward ).multiplyScalar( axleF ); F.add( _a ); T.add( _c.crossVectors( _b, _a ) );
		_a.copy( this.up ).multiplyScalar( - df * ( 1 - def.aero.balance ) );
		_b.copy( this.forward ).multiplyScalar( axleR ); F.add( _a ); T.add( _c.crossVectors( _b, _a ) );
		// aero yaw damping (keeps high-speed straights calm)
		T.addScaledVector( this.up, - this.angularVelocity.dot( this.up ) * 0.02 * v2 );

		// --- integrate
		this.velocity.addScaledVector( F, this.invMass * dt );
		// torque → body space → angular acceleration (with gyroscopic term)
		_q.copy( this.quaternion ).invert();
		_a.copy( T ).applyQuaternion( _q );
		_b.copy( this.angularVelocity ).applyQuaternion( _q );
		_c.set( this.inertia.x * _b.x, this.inertia.y * _b.y, this.inertia.z * _b.z );
		_c.crossVectors( _b, _c ); // ω × (Iω)
		_a.sub( _c );
		_b.x += _a.x * this.invInertia.x * dt; _b.y += _a.y * this.invInertia.y * dt; _b.z += _a.z * this.invInertia.z * dt;
		_b.multiplyScalar( 1 - 0.3 * dt ); // small angular damping
		this.angularVelocity.copy( _b ).applyQuaternion( this.quaternion );
		this.position.addScaledVector( this.velocity, dt );
		// q += 0.5 * (ω q) dt
		_wq.set( this.angularVelocity.x * dt * 0.5, this.angularVelocity.y * dt * 0.5, this.angularVelocity.z * dt * 0.5, 0 );
		_wq.multiply( this.quaternion );
		this.quaternion.x += _wq.x; this.quaternion.y += _wq.y; this.quaternion.z += _wq.z; this.quaternion.w += _wq.w;
		this.quaternion.normalize();
		this.updateAxes();

		// --- track projection (progress, surface) and walls
		this.track.project( this.position.x, this.position.z, this.trackHint, this.proj );
		this.trackHint = this.proj.index;
		this.onTrackLateral = this.proj.lateral;
		this._walls( dt );
		// safety: never fall below the ground (recover from glitches)
		if ( this.position.y < this.proj.height - 2 ) {
			this.position.y = this.proj.height + def.cgHeight + 0.3; this.velocity.y = 0;
		}
		// upside-down recovery: slowly right the car when it is on its roof and stopped
		if ( this.up.y < 0.2 && this.speed < 2 ) {
			_q.setFromAxisAngle( _up, Math.atan2( this.forward.x, this.forward.z ) );
			this.quaternion.slerp( _q, 0.05 );
			this.position.y = Math.max( this.position.y, this.proj.height + def.cgHeight + 0.3 );
		}

		// --- telemetry
		_a.copy( this.velocity ); // g-forces from acceleration (velocity delta)
		const accel = _b.copy( this.velocity ).sub( this._lastVel || this.velocity ).divideScalar( dt );
		this.lateralG = accel.dot( this.left ) / G;
		this.longG = accel.dot( this.forward ) / G;
		( this._lastVel || ( this._lastVel = new Vector3() ) ).copy( this.velocity );
	}

	_gearbox( dt, vLong ) {
		const eng = this.engine, c = this.controls, def = this.def;
		eng.shiftTimer = Math.max( 0, eng.shiftTimer - dt );
		const n = def.gears.length;
		if ( this.aids.autoGear ) {
			if ( eng.gear === - 1 ) {
				if ( vLong > - 0.6 && c.throttle > 0.3 ) { eng.gear = 1; eng.shiftTimer = 0.1; }
			} else {
				// hold brake while (almost) stopped → reverse
				if ( Math.abs( vLong ) < 0.6 && c.brake > 0.5 && c.throttle < 0.1 && ! c.handbrake ) { this.reverseTimer += dt; if ( this.reverseTimer > 0.45 ) { eng.gear = - 1; this.reverseTimer = 0; } }
				else this.reverseTimer = 0;
				if ( eng.shiftTimer <= 0 ) {
					if ( eng.rpm > def.engine.redline * 0.965 && eng.gear < n && c.throttle > 0.2 ) { eng.gear ++; eng.shiftTimer = 0.18; }
					else if ( eng.rpm < def.engine.redline * 0.46 && eng.gear > 1 ) { eng.gear --; eng.shiftTimer = 0.14; }
				}
			}
		} else {
			if ( c.gearUp && eng.gear < n && eng.shiftTimer <= 0 ) { eng.gear = eng.gear === - 1 ? 1 : eng.gear + 1; eng.shiftTimer = 0.18; }
			if ( c.gearDown && eng.gear > - 1 && eng.shiftTimer <= 0 ) { eng.gear = eng.gear === 1 ? - 1 : eng.gear - 1; eng.shiftTimer = 0.14; }
		}
		c.gearUp = false; c.gearDown = false;
	}

	/** Keep the body inside the track's lateral limits (barriers). */
	_walls( dt ) {
		const def = this.def;
		const e = 0.25; // restitution
		for ( const cp of this.cornerPoints ) {
			_a.copy( cp ).applyQuaternion( this.quaternion ).add( this.position );
			const p = this.track.project( _a.x, _a.z, this.trackHint, this._wallProj || ( this._wallProj = {} ) );
			const lat = p.lateral;
			const limit = p.wallLateral;
			if ( Math.abs( lat ) <= limit ) continue;
			if ( _a.y > p.height + 2.0 ) continue; // flew over the wall
			const pen = Math.abs( lat ) - limit;
			const sgn = Math.sign( lat );
			// wall normal points back onto the track (XZ)
			_b.set( p.rx, 0, p.rz ).normalize().multiplyScalar( - sgn );
			// positional correction
			this.position.addScaledVector( _b, pen * 0.9 );
			// impulse at the corner point
			_c.subVectors( _a, this.position );
			_d.crossVectors( this.angularVelocity, _c ).add( this.velocity );
			const vn = _d.dot( _b );
			if ( vn >= 0 ) continue;
			const mEff = this.mass * 0.55;
			const j = - ( 1 + e ) * vn * mEff;
			this.velocity.addScaledVector( _b, j * this.invMass );
			// angular response
			_e.crossVectors( _c, _b ).multiplyScalar( j );
			_q.copy( this.quaternion ).invert();
			_e.applyQuaternion( _q );
			_e.x *= this.invInertia.x; _e.y *= this.invInertia.y; _e.z *= this.invInertia.z;
			_e.applyQuaternion( this.quaternion );
			this.angularVelocity.addScaledVector( _e, 0.5 );
			// friction along the wall
			_d.addScaledVector( _b, - vn ); // tangential velocity
			const vtLen = _d.length();
			if ( vtLen > 0.01 ) this.velocity.addScaledVector( _d.normalize(), - Math.min( vtLen, 0.35 * Math.abs( j ) * this.invMass ) );
			const strength = clamp( - vn / 12, 0, 1 );
			if ( strength > 0.08 && this.hitCooldown <= 0 ) {
				this.hitCooldown = 0.12;
				this.damage = clamp( this.damage + strength * 0.25, 0, 1 );
				this.collisions.push( { point: _a.clone(), strength, normal: _b.clone(), wall: true } );
			}
		}
	}

	/** Car ↔ car collision: XZ oriented-box SAT with impulse response. */
	static collide( a, b ) {
		// quick reject
		const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
		if ( dx * dx + dz * dz > 36 ) return false;
		const axes = [];
		const fa = a.forward, fb = b.forward;
		axes.push( [ fa.x, fa.z ], [ - fa.z, fa.x ], [ fb.x, fb.z ], [ - fb.z, fb.x ] );
		let minOverlap = Infinity, minAxis = null;
		const projRadius = ( v, ax ) => Math.abs( v.forward.x * ax[ 0 ] + v.forward.z * ax[ 1 ] ) * v.halfLength + Math.abs( - v.forward.z * ax[ 0 ] + v.forward.x * ax[ 1 ] ) * v.halfWidth;
		for ( const ax of axes ) {
			const len = Math.hypot( ax[ 0 ], ax[ 1 ] ) || 1; ax[ 0 ] /= len; ax[ 1 ] /= len;
			const dist = dx * ax[ 0 ] + dz * ax[ 1 ];
			const overlap = projRadius( a, ax ) + projRadius( b, ax ) - Math.abs( dist );
			if ( overlap <= 0 ) return false;
			if ( overlap < minOverlap ) { minOverlap = overlap; minAxis = dist < 0 ? [ - ax[ 0 ], - ax[ 1 ] ] : ax; }
		}
		// separate
		const n = _b.set( minAxis[ 0 ], 0, minAxis[ 1 ] ); // from a toward b
		const ma = a.invMass / ( a.invMass + b.invMass ), mb = 1 - ma;
		a.position.addScaledVector( n, - minOverlap * ma * 0.8 );
		b.position.addScaledVector( n, minOverlap * mb * 0.8 );
		// impulse at the midpoint
		_c.addVectors( a.position, b.position ).multiplyScalar( 0.5 );
		_d.subVectors( _c, a.position ); _e.subVectors( _c, b.position );
		_a.crossVectors( a.angularVelocity, _d ).add( a.velocity );
		_f.crossVectors( b.angularVelocity, _e ).add( b.velocity );
		_a.sub( _f ); // relative velocity a - b
		const vn = _a.dot( n );
		if ( vn <= 0 ) return true;
		const e = 0.3;
		const j = ( 1 + e ) * vn / ( a.invMass + b.invMass ) * 0.7;
		a.velocity.addScaledVector( n, - j * a.invMass );
		b.velocity.addScaledVector( n, j * b.invMass );
		// yaw response: push noses apart
		const ya = _d.x * n.z - _d.z * n.x, yb = _e.x * n.z - _e.z * n.x;
		a.angularVelocity.y += ya * j * a.invInertia.y * 0.6;
		b.angularVelocity.y -= yb * j * b.invInertia.y * 0.6;
		// friction
		_a.addScaledVector( n, - vn );
		const vt = _a.length();
		if ( vt > 0.05 ) {
			_a.normalize();
			const jt = Math.min( vt / ( a.invMass + b.invMass ), 0.4 * j );
			a.velocity.addScaledVector( _a, - jt * a.invMass );
			b.velocity.addScaledVector( _a, jt * b.invMass );
		}
		const strength = clamp( vn / 10, 0, 1 );
		if ( strength > 0.1 ) {
			const pt = _c.clone();
			if ( a.hitCooldown <= 0 ) { a.hitCooldown = 0.15; a.damage = clamp( a.damage + strength * 0.15, 0, 1 ); a.collisions.push( { point: pt, strength, normal: n.clone(), other: b } ); }
			if ( b.hitCooldown <= 0 ) { b.hitCooldown = 0.15; b.damage = clamp( b.damage + strength * 0.15, 0, 1 ); b.collisions.push( { point: pt, strength, normal: n.clone().negate(), other: a } ); }
		}
		return true;
	}

	/** Interpolated render transform. */
	getRenderTransform( alpha, outPos, outQuat ) {
		outPos.lerpVectors( this.prevPosition, this.position, alpha );
		outQuat.slerpQuaternions( this.prevQuaternion, this.quaternion, alpha );
	}
}
