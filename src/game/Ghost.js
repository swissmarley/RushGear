/**
 * Ghost laps for Time Trial: records the player's lap at 20 Hz, keeps the best, persists it
 * (compact, quantised) and replays it as a translucent car.
 */
import { Vector3, Quaternion } from 'three/webgpu';

const RATE = 20;

export class GhostRecorder {
	constructor() { this.frames = []; this.acc = 0; this.active = false; }
	start() { this.frames = []; this.acc = 0; this.active = true; }
	stop() { this.active = false; }
	record( vehicle, dt ) {
		if ( ! this.active ) return;
		this.acc += dt;
		if ( this.acc < 1 / RATE ) return;
		this.acc -= 1 / RATE;
		const p = vehicle.position, q = vehicle.quaternion;
		this.frames.push( [ + p.x.toFixed( 2 ), + p.y.toFixed( 2 ), + p.z.toFixed( 2 ), + q.x.toFixed( 3 ), + q.y.toFixed( 3 ), + q.z.toFixed( 3 ), + q.w.toFixed( 3 ), + vehicle.steerAngle.toFixed( 2 ) ] );
	}
	toData( lapTime, carId ) { return { rate: RATE, lapTime, carId, frames: this.frames }; }
}

export class GhostPlayer {
	constructor( data, car ) {
		this.data = data; this.car = car; this.time = 0;
		this._q = new Quaternion(); this._q2 = new Quaternion();
		this.spin = 0;
	}
	reset() { this.time = 0; }
	update( dt ) {
		const fr = this.data.frames;
		if ( ! fr.length ) return;
		this.time += dt;
		const f = this.time * this.data.rate;
		if ( f >= fr.length - 1 ) { this.car.root.visible = false; return; }
		this.car.root.visible = true;
		const i = Math.floor( f ), t = f - i;
		const a = fr[ i ], b = fr[ i + 1 ];
		this.car.root.position.set( a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t );
		this._q.set( a[ 3 ], a[ 4 ], a[ 5 ], a[ 6 ] ); this._q2.set( b[ 3 ], b[ 4 ], b[ 5 ], b[ 6 ] );
		this.car.root.quaternion.slerpQuaternions( this._q, this._q2, t );
		const dist = Math.hypot( b[ 0 ] - a[ 0 ], b[ 2 ] - a[ 2 ] ) * this.data.rate;
		this.spin += dist / 0.34 * dt;
		for ( const w of this.car.wheels ) { w.pivot.rotation.y = w.front ? a[ 7 ] : 0; w.spin.rotation.x = this.spin; }
	}
}
