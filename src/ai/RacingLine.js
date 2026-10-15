/**
 * Racing line: minimum-curvature path optimisation across the track width, plus a speed
 * profile with braking points derived from the car's grip and acceleration limits.
 *
 * The line is a lateral offset per track sample. Gradient descent on the squared second
 * difference of the path (the discrete curvature) with clamping to the track edges gives
 * the classic "straighten the corners, use all the road" line.
 */
import { Vector3 } from 'three/webgpu';
import { clamp, lerp } from '../core/math.js';

const _p = new Vector3();

export class RacingLine {
	constructor( track, opts = {} ) {
		this.track = track;
		this.margin = opts.margin ?? 1.6;      // keep this far from the edge
		this.step = opts.step ?? 3;            // optimise every 3rd sample (6 m) and interpolate
		this.offsets = null;                   // per-sample lateral offset
		this.points = null;                    // per-sample world positions on the line
		this.curv = null;                      // per-sample curvature of the line
		this.speed = null;                     // per-sample target speed (m/s)
		this.brakeZones = [];
		this.optimise( opts.iterations ?? 400 );
	}

	optimise( iterations ) {
		const S = this.track.samples, N = S.length, step = this.step;
		const M = Math.floor( N / step );
		const off = new Float32Array( M );
		const lim = new Float32Array( M );
		const px = new Float32Array( M ), pz = new Float32Array( M );
		for ( let i = 0; i < M; i ++ ) lim[ i ] = Math.max( 0.5, S[ i * step ].width / 2 - this.margin );
		const pos = ( i ) => { const s = S[ i * step ]; px[ i ] = s.pos.x + s.right.x * off[ i ]; pz[ i ] = s.pos.z + s.right.z * off[ i ]; };
		for ( let i = 0; i < M; i ++ ) pos( i );
		// gradient descent on Σ |p[i-1] - 2 p[i] + p[i+1]|²
		const rate = 0.25;
		for ( let it = 0; it < iterations; it ++ ) {
			for ( let i = 0; i < M; i ++ ) {
				const a = ( i - 1 + M ) % M, b = ( i + 1 ) % M;
				// second difference at i, and the contributions where i is a neighbour
				const dx0 = px[ a ] - 2 * px[ i ] + px[ b ], dz0 = pz[ a ] - 2 * pz[ i ] + pz[ b ];
				const a2 = ( i - 2 + M ) % M, b2 = ( i + 2 ) % M;
				const dxa = px[ a2 ] - 2 * px[ a ] + px[ i ], dza = pz[ a2 ] - 2 * pz[ a ] + pz[ i ];
				const dxb = px[ i ] - 2 * px[ b ] + px[ b2 ], dzb = pz[ i ] - 2 * pz[ b ] + pz[ b2 ];
				const s = S[ i * step ];
				// d/d off[i] of the objective: (-2)·d0 + 1·da + 1·db  projected on the right vector
				const gx = - 2 * dx0 + dxa + dxb, gz = - 2 * dz0 + dza + dzb;
				const grad = gx * s.right.x + gz * s.right.z;
				off[ i ] = clamp( off[ i ] - rate * grad, - lim[ i ], lim[ i ] );
				pos( i );
			}
		}
		// smooth and upsample to every sample
		this.offsets = new Float32Array( N );
		for ( let i = 0; i < N; i ++ ) {
			const f = i / step, k = Math.floor( f ) % M, t = f - Math.floor( f );
			this.offsets[ i ] = lerp( off[ k ], off[ ( k + 1 ) % M ], t );
		}
		this.points = new Array( N );
		for ( let i = 0; i < N; i ++ ) {
			const s = S[ i ];
			this.points[ i ] = new Vector3().copy( s.pos ).addScaledVector( s.right, this.offsets[ i ] );
		}
		this.curv = new Float32Array( N );
		for ( let i = 0; i < N; i ++ ) {
			const a = this.points[ ( i - 2 + N ) % N ], b = this.points[ i ], c = this.points[ ( i + 2 ) % N ];
			const t0x = b.x - a.x, t0z = b.z - a.z, t1x = c.x - b.x, t1z = c.z - b.z;
			const a0 = Math.atan2( t0x, t0z ), a1 = Math.atan2( t1x, t1z );
			let d = a1 - a0; if ( d > Math.PI ) d -= 2 * Math.PI; if ( d < - Math.PI ) d += 2 * Math.PI;
			// the two tangents are measured at segment midpoints half the span apart
			const ds = ( Math.hypot( t0x, t0z ) + Math.hypot( t1x, t1z ) ) * 0.5;
			this.curv[ i ] = d / Math.max( 0.1, ds );
		}
		// light smoothing of curvature
		const c2 = new Float32Array( N );
		for ( let i = 0; i < N; i ++ ) { let sum = 0; for ( let j = - 3; j <= 3; j ++ ) sum += this.curv[ ( i + j + N ) % N ]; c2[ i ] = sum / 7; }
		this.curv = c2;
	}

	/**
	 * Speed profile for a car: v = sqrt(aLat · R) limited by braking (backward pass) and
	 * acceleration (forward pass). `car` is a CarData definition.
	 */
	buildSpeedProfile( car, wetness = 0, opts = {} ) {
		const S = this.track.samples, N = S.length;
		const ds = this.track.length / N;
		const g = 9.81;
		const mu = car.tyres.grip * ( 1 - 0.3 * wetness ) * ( opts.gripFactor ?? 0.9 );
		const mass = car.mass;
		const vMax = Math.sqrt( ( car.engine.maxTorque * car.gears[ car.gears.length - 1 ] * car.finalDrive * 0.9 / car.wheelRadius ) / ( 0.5 * 1.225 * car.aero.cd * car.aero.area ) ) * 0.98;
		const v = new Float32Array( N );
		// lateral limit including downforce: a_lat = mu (g + 0.5 rho Cl A v² / m)
		for ( let i = 0; i < N; i ++ ) {
			const k = Math.abs( this.curv[ i ] ) + 1e-4;
			// solve v² k = mu (g + c v²)  →  v² (k - mu c) = mu g ; then iterate once with a
			// speed-dependent grip derating (load transfer & load sensitivity bite harder at speed)
			const c = 0.5 * 1.225 * car.aero.downforce / mass * 0.7; // downforce helps less than ideal (load sensitivity)
			// banking: a corner banked toward its inside multiplies the usable lateral capacity
			const bank = S[ i ].bank * Math.sign( this.curv[ i ] || 1 ); // >0 when banked into the turn
			const sb = Math.sin( Math.max( - 0.2, bank ) ), cb = Math.cos( bank );
			let vl = vMax;
			for ( let it = 0; it < 3; it ++ ) {
				const muV = mu * ( 1 - 0.003 * Math.min( vl, 90 ) );
				const muB = clamp( ( sb + muV * cb ) / Math.max( 0.2, cb - muV * sb ), 0.3, 6 );
				const denom = k - muB * c;
				vl = denom > 1e-5 ? Math.min( vMax, Math.sqrt( muB * g / denom ) ) : vMax;
			}
			v[ i ] = vl;
		}
		// backward pass: braking  v_i² ≤ v_{i+1}² + 2 a_brake ds
		for ( let pass = 0; pass < 2; pass ++ ) for ( let i = N - 1; i >= 0; i -- ) {
			const n = v[ ( i + 1 ) % N ];
			// downhill grade steals braking (slope = tangent.y, negative when descending)
			const aBrake = Math.max( 2, mu * g * 0.95 + g * S[ i ].tangent.y );
			v[ i ] = Math.min( v[ i ], Math.sqrt( n * n + 2 * aBrake * ds ) );
		}
		// forward pass: acceleration limit a(v) = min(F_engine/m, mu g) - drag
		for ( let pass = 0; pass < 2; pass ++ ) for ( let i = 0; i < N; i ++ ) {
			const p = v[ ( i - 1 + N ) % N ];
			const fEng = car.engine.maxTorque * 0.85 * car.gears[ 1 ] * car.finalDrive * 0.9 / car.wheelRadius; // ~2nd gear thrust
			const drag = 0.5 * 1.225 * car.aero.cd * car.aero.area * p * p;
			const a = Math.max( 0.3, Math.min( ( fEng - drag ) / mass * ( 0.5 + 0.5 * clamp( 60 / Math.max( p, 1 ), 0, 1 ) ), mu * g * ( car.drivetrain === 'AWD' ? 0.9 : 0.6 ) ) - g * S[ i ].tangent.y );
			v[ i ] = Math.min( v[ i ], Math.sqrt( p * p + 2 * a * ds ) );
		}
		this.speed = v;
		// braking zones: where the profile falls → used for brake lights/AI "braking points"
		this.brakeZones.length = 0;
		for ( let i = 0; i < N; i ++ ) if ( v[ i ] < v[ ( i - 1 + N ) % N ] - 0.05 && ! ( v[ ( i - 1 + N ) % N ] < v[ ( i - 2 + N ) % N ] - 0.05 ) ) this.brakeZones.push( i );
		return new SpeedProfile( this, v, this.brakeZones.slice() );
	}

	/** Cached per-car speed profile. */
	profileFor( car, wetness = 0 ) {
		this._profiles = this._profiles || new Map();
		const key = car.id + ':' + wetness.toFixed( 2 );
		if ( ! this._profiles.has( key ) ) this._profiles.set( key, this.buildSpeedProfile( car, wetness ) );
		return this._profiles.get( key );
	}

	/** Position on the line at distance s (metres along the track). */
	pointAt( s, out = new Vector3() ) {
		const L = this.track.length, N = this.points.length;
		s = ( ( s % L ) + L ) % L;
		const f = s / L * N, i = Math.floor( f ) % N, t = f - Math.floor( f );
		return out.lerpVectors( this.points[ i ], this.points[ ( i + 1 ) % N ], t );
	}
	offsetAt( s ) {
		const L = this.track.length, N = this.offsets.length;
		s = ( ( s % L ) + L ) % L;
		const f = s / L * N, i = Math.floor( f ) % N, t = f - Math.floor( f );
		return lerp( this.offsets[ i ], this.offsets[ ( i + 1 ) % N ], t );
	}
	speedAt( s ) { return this.speed ? SpeedProfile.prototype.speedAt.call( { line: this, speed: this.speed }, s ) : 0; }
	curvatureAt( s ) {
		const L = this.track.length, N = this.curv.length;
		s = ( ( s % L ) + L ) % L;
		return this.curv[ Math.floor( s / L * N ) % N ];
	}
}

/** Target speed per track sample for one car, with look-ahead helpers for the AI. */
export class SpeedProfile {
	constructor( line, speed, brakeZones ) { this.line = line; this.speed = speed; this.brakeZones = brakeZones; }
	speedAt( s ) {
		const L = this.line.track.length, N = this.speed.length;
		s = ( ( s % L ) + L ) % L;
		const f = s / L * N, i = Math.floor( f ) % N, t = f - Math.floor( f );
		return lerp( this.speed[ i ], this.speed[ ( i + 1 ) % N ], t );
	}
	/** Minimum profile speed over the next `dist` metres (what the car must slow to). */
	minSpeedAhead( s, dist ) {
		const L = this.line.track.length, N = this.speed.length;
		const stepM = L / N;
		let m = Infinity;
		for ( let d = 0; d <= dist; d += stepM * 2 ) m = Math.min( m, this.speedAt( s + d ) );
		return m;
	}
}
