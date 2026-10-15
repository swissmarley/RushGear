/**
 * AI driver with personality. Follows the racing line with a look-ahead pursuit controller,
 * brakes for corners from the speed profile, attacks and defends, avoids contact and makes
 * (rare) mistakes. Runs inside the fixed 120 Hz step but makes tactical decisions at ~5 Hz.
 */
import { Vector3 } from 'three/webgpu';
import { clamp, lerp, damp, makeRNG } from '../core/math.js';

const _t = new Vector3(), _d = new Vector3();

export const AI_PERSONALITIES = [
	{ name: 'Mara Voss', skill: 0.97, aggression: 0.9, consistency: 0.92, defence: 0.8, color: '#ffb400' },
	{ name: 'Kenji Arai', skill: 0.95, aggression: 0.6, consistency: 0.97, defence: 0.6, color: '#4cd2ff' },
	{ name: 'Luca Ferri', skill: 0.93, aggression: 0.95, consistency: 0.8, defence: 0.9, color: '#ff4c4c' },
	{ name: 'Ada Lindqvist', skill: 0.92, aggression: 0.5, consistency: 0.95, defence: 0.5, color: '#b4ff4c' },
	{ name: 'Tomas Reyes', skill: 0.9, aggression: 0.75, consistency: 0.85, defence: 0.7, color: '#ff8ae0' },
	{ name: 'Yara Haddad', skill: 0.89, aggression: 0.8, consistency: 0.88, defence: 0.75, color: '#8a9bff' },
	{ name: 'Oskar Brandt', skill: 0.87, aggression: 0.4, consistency: 0.9, defence: 0.4, color: '#ffffff' },
	{ name: 'Nina Okafor', skill: 0.85, aggression: 0.7, consistency: 0.75, defence: 0.6, color: '#4cffb4' }
];

export class AIDriver {
	constructor( vehicle, line, profile, personality, opts = {} ) {
		this.v = vehicle;
		this.line = line;
		this.profile = profile;
		this.p = personality;
		this.rng = makeRNG( opts.seed ?? 1 );
		this.difficulty = opts.difficulty ?? 1.0; // scales target speeds
		this.lateralTarget = 0;      // desired offset relative to the racing line
		this.lateral = 0;            // smoothed
		this.decisionTimer = this.rng() * 0.2;
		this.mode = 'race';          // race | attack | defend | recover
		this.mistake = 0;            // >0 while making a mistake (late braking / missed apex)
		this.mistakeTimer = 5 + this.rng() * 20;
		this.stuckTimer = 0;
		this.reverseTimer = 0;
		this.others = [];
		this.target = new Vector3();
		this.speedScale = 1;
		this.caution = 1;
		this.lastProgress = 0;
	}

	setOthers( vehicles ) { this.others = vehicles.filter( ( o ) => o !== this.v ); }

	update( dt, race ) {
		const v = this.v, c = v.controls, line = this.line, p = this.p;
		const s = v.proj.s;
		const speed = Math.max( 0, v.localVel.z );
		this.decisionTimer -= dt;
		if ( this.decisionTimer <= 0 ) { this.decisionTimer = 0.2; this._decide( race ); }

		// --- recovery (stuck against a wall or facing backwards)
		const facing = v.forward.x * v.proj.tx + v.forward.z * v.proj.tz; // cos(heading error)
		if ( race?.started && this.mode !== 'recover' && ( ( speed < 1.5 && c.throttle > 0.5 ) || facing < - 0.3 ) ) this.stuckTimer += dt; else if ( this.mode !== 'recover' ) this.stuckTimer = Math.max( 0, this.stuckTimer - dt );
		if ( this.stuckTimer > 1.6 && this.mode !== 'recover' ) { this.mode = 'recover'; this.recoverPhase = 'reverse'; this.reverseTimer = 1.2 + this.rng() * 0.8; this.stuckTimer = 0; }
		if ( this.mode === 'recover' ) {
			// heading error to the track direction (>0: tangent is to our left)
			const leftOfTrack = v.left.x * v.proj.tx + v.left.z * v.proj.tz; // sin(heading error), >0 when the track direction is to our left
			const headingErr = Math.atan2( leftOfTrack, facing );
			if ( this.recoverPhase === 'reverse' ) {
				this.reverseTimer -= dt;
				c.throttle = 0; c.brake = 1; c.handbrake = 0; // brake pedal = reverse with the automatic gearbox
				// reversing with the wheels turned right swings the nose left (and vice versa)
				c.steer = clamp( headingErr * 1.5, - 1, 1 );
				// also steer back toward the road centre
				c.steer = clamp( c.steer + Math.sign( v.proj.lateral ) * 0.3, - 1, 1 );
				if ( this.reverseTimer <= 0 || Math.abs( headingErr ) < 0.25 && Math.abs( v.proj.lateral ) < v.proj.width / 2 ) { this.recoverPhase = 'forward'; this.reverseTimer = 2.5; v.engine.gear = 1; }
				return;
			}
			// forward phase: gentle drive back onto the line
			this.reverseTimer -= dt;
			this.caution = 0.5;
			if ( this.reverseTimer <= 0 && Math.abs( v.proj.lateral ) < v.proj.width / 2 + 1 ) { this.mode = 'race'; this.caution = 1; }
			else if ( this.reverseTimer <= - 3 ) { this.mode = 'race'; }
		}
		if ( v.engine.gear === - 1 && this.mode !== 'recover' ) { v.engine.gear = 1; }

		// --- steering: curvature feed-forward from the line + pure-pursuit feedback
		this.lateral = damp( this.lateral, this.lateralTarget, 2.5, dt );
		const look = clamp( 6 + speed * 0.55, 8, 50 );
		const sAhead = s + look;
		line.pointAt( sAhead, this.target );
		const sm = v.track.sampleAt( sAhead );
		const half = sm.width / 2 - 1.3;
		const lineOff = line.offsetAt( sAhead );
		const off = clamp( lineOff + this.lateral, - half, half ) - lineOff;
		this.target.addScaledVector( sm.right, off );
		_d.subVectors( this.target, v.position );
		const lx = _d.dot( v.left ), lz = _d.dot( v.forward );
		const dist2 = Math.max( 4, lx * lx + lz * lz );
		// pure pursuit: curvature of the arc through the target (positive = left)
		const kPursuit = 2 * lx / dist2;
		// feed-forward: curvature of the line a little ahead of the car
		const kLine = line.curvatureAt( s + 4 + speed * 0.15 );
		const kTotal = kLine * 0.85 + kPursuit * ( 0.9 + 0.3 * p.skill );
		// Ackermann steer angle for that curvature, as a fraction of the speed-sensitive lock
		const wheelbase = v.def.wheelbase;
		const lock = v.def.steerMax / ( 1 + speed * 0.045 );
		let steerAngle = Math.atan( kTotal * wheelbase ) * ( 1 + speed * 0.004 ); // mild understeer compensation
		let steer = - steerAngle / lock; // steer>0 is right, positive curvature is left
		// yaw-rate damping and counter-steer when the rear steps out
		const yawRate = v.angularVelocity.dot( v.up );
		const rearSlip = ( v.wheels[ 2 ].slipAngle + v.wheels[ 3 ].slipAngle ) * 0.5;
		steer += yawRate * 0.03 * clamp( speed / 20, 0, 1 );
		steer -= rearSlip * 1.2 * p.skill;
		if ( this.mistake > 0 ) steer += Math.sin( this.mistake * 9 ) * 0.08;
		c.steer = clamp( steer, - 1, 1 );

		// --- speed: profile target with personality, braking distance look-ahead
		const skillScale = lerp( 0.86, 1.0, p.skill ) * this.difficulty;
		const brakeDist = speed * speed / ( 2 * ( 8.0 + 2.0 * p.skill ) ) + speed * 0.3 + 5;
		let targetSpeed = this.profile.minSpeedAhead( s, brakeDist + 8 );
		// consider also the speed at the current point so we don't overshoot the apex
		targetSpeed = Math.min( targetSpeed, this.profile.speedAt( s + 3 ) * 1.01 );
		targetSpeed *= skillScale * this.speedScale * this.caution;
		if ( this.mistake > 0 ) targetSpeed *= 1.07; // late braking mistake
		const err = targetSpeed - speed;
		let throttle = 0, brake = 0;
		if ( err > 0.5 ) throttle = clamp( err * 0.35 + 0.25, 0, 1 );
		else if ( err < - 0.6 ) brake = clamp( - err * 0.18, 0.15, 1 );
		else throttle = clamp( 0.45 + err * 0.3, 0, 1 );
		// car ahead too close on our line → match its speed
		const ahead = this._carAhead( 4.0 );
		if ( ahead ) {
			const gap = ahead.gap - 4.8;
			const closing = speed - Math.max( 0, ahead.vehicle.localVel.z );
			if ( gap < Math.max( 6, closing * 1.2 ) + 3 ) {
				if ( closing > 0.3 || gap < 3 ) { brake = Math.max( brake, clamp( ( closing * 0.25 + ( 3 - gap ) * 0.3 ), 0.2, 1 ) ); throttle = 0; }
				else throttle = Math.min( throttle, 0.5 );
			}
		}
		// do not trail-brake into a slide: braking under high lateral load unloads the rear
		const latLoad = Math.abs( v.lateralG );
		if ( latLoad > 0.6 ) brake *= clamp( 1 - ( latLoad - 0.6 ) * 1.4, 0.1, 1 );
		// understeer mitigation: when the front tyres pass their peak slip angle, lift (and brush the
		// brakes) so the nose tucks in instead of ploughing wide
		const frontSlip = Math.abs( v.wheels[ 0 ].slipAngle + v.wheels[ 1 ].slipAngle ) * 0.5;
		if ( speed > 12 && frontSlip > 0.085 ) {
			const u = clamp( ( frontSlip - 0.085 ) / 0.06, 0, 1 );
			throttle *= 1 - u * 0.9;
			if ( u > 0.6 && latLoad < 1.0 ) brake = Math.max( brake, ( u - 0.6 ) * 0.5 );
		}
		// traction sanity: ease throttle under heavy slip angle or wheelspin
		const spin = Math.max( v.wheels[ 2 ].slipRatio, v.wheels[ 3 ].slipRatio );
		if ( spin > 0.3 ) throttle *= 0.6;
		if ( Math.abs( rearSlip ) > 0.25 ) throttle *= 0.5;
		if ( ! race?.started ) { throttle = 0; brake = 0; }
		c.throttle = damp( c.throttle, throttle, 12, dt );
		c.brake = damp( c.brake, brake, 20, dt );
		c.handbrake = 0;
		if ( this.mistake > 0 ) this.mistake -= dt;
	}

	/** Nearest other car ahead within `lateralTolerance` metres of our lateral position. */
	_carAhead( lateralTolerance ) {
		const v = this.v, L = v.track.length;
		let best = null;
		for ( const o of this.others ) {
			let gap = o.proj.s - v.proj.s;
			if ( gap < - L / 2 ) gap += L; if ( gap > L / 2 ) gap -= L;
			if ( gap < 0 || gap > 60 ) continue;
			if ( Math.abs( o.proj.lateral - v.proj.lateral ) > lateralTolerance ) continue;
			if ( ! best || gap < best.gap ) best = { vehicle: o, gap };
		}
		return best;
	}

	/** Tactical decisions at 5 Hz: attack, defend, mistakes, caution. */
	_decide( race ) {
		if ( this.mode === 'recover' ) return;
		const v = this.v, p = this.p, L = v.track.length;
		const s = v.proj.s, speed = v.speed;
		// occasional mistakes scale with (1 - consistency)
		this.mistakeTimer -= 0.2;
		if ( this.mistakeTimer <= 0 ) { this.mistakeTimer = 8 + this.rng() * 40 * p.consistency; if ( this.rng() > p.consistency ) this.mistake = 0.6 + this.rng() * 0.8; }
		// random pace variation per decision to keep the field alive
		this.speedScale = damp( this.speedScale, 1 + ( this.rng() - 0.5 ) * 0.03 * ( 1 - p.consistency ), 1, 0.2 );
		// caution in the first seconds of the race and when damaged
		this.caution = race && race.time < 6 ? 0.92 : 1 - v.damage * 0.08;

		// find the closest car ahead and behind
		let ahead = null, behind = null;
		for ( const o of this.others ) {
			let gap = o.proj.s - s;
			if ( gap < - L / 2 ) gap += L; if ( gap > L / 2 ) gap -= L;
			if ( gap > 0 && gap < 40 && ( ! ahead || gap < ahead.gap ) ) ahead = { o, gap };
			if ( gap < 0 && gap > - 25 && ( ! behind || gap > behind.gap ) ) behind = { o, gap };
		}
		const upcomingCurv = this.line.curvatureAt( s + 40 + speed * 1.5 );
		let target = 0;
		this.mode = 'race';
		if ( ahead && ahead.gap < 12 + speed * 0.4 && speed >= ahead.o.speed - 1 ) {
			// attack: pick the side with more room; aggressive drivers dive to the inside
			const oLat = ahead.o.proj.lateral, half = v.proj.width / 2 - 1.5;
			const inside = upcomingCurv > 0 ? - 1 : 1; // left turn → inside is left (negative lateral)
			const roomLeft = half + oLat, roomRight = half - oLat;
			let side = roomLeft > roomRight ? - 1 : 1;
			if ( p.aggression > 0.7 && ( inside < 0 ? roomLeft : roomRight ) > 2.6 ) side = inside;
			target = ( oLat + side * 3.0 ) - this.line.offsetAt( s + 20 );
			this.mode = 'attack';
			if ( p.aggression < 0.45 && ahead.gap < 6 ) target *= 0.5; // timid: hang back
		} else if ( behind && behind.gap > - 15 && behind.o.speed > speed - 0.5 && p.defence > 0.5 && Math.abs( upcomingCurv ) > 1 / 250 ) {
			// defend: cover the inside of the next corner
			const inside = upcomingCurv > 0 ? - 1 : 1;
			target = inside * ( v.proj.width / 2 - 2.5 ) - this.line.offsetAt( s + 20 );
			this.mode = 'defend';
		}
		// avoid side-by-side contact: if someone is alongside, move away from them
		for ( const o of this.others ) {
			let gap = o.proj.s - s; if ( gap < - L / 2 ) gap += L; if ( gap > L / 2 ) gap -= L;
			if ( Math.abs( gap ) < 5.5 ) {
				const dl = v.proj.lateral - o.proj.lateral;
				if ( Math.abs( dl ) < 3.2 ) target += Math.sign( dl || 1 ) * ( 3.2 - Math.abs( dl ) ) * 1.2;
			}
		}
		this.lateralTarget = clamp( target, - 6, 6 );
	}
}
