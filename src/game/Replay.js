/**
 * Replay recorder/player. Records every car's transform (+ wheel steer/spin, lights) at 30 Hz
 * into typed-array ring buffers; playback interpolates frames and drives the visuals directly.
 */
import { Vector3, Quaternion } from 'three/webgpu';

const RATE = 30;
const STRIDE = 12; // px py pz qx qy qz qw steer spin brake rpm speed

export class ReplayRecorder {
	constructor( cars, maxSeconds = 900 ) {
		this.cars = cars;
		this.maxFrames = maxSeconds * RATE;
		this.buffers = cars.map( () => new Float32Array( this.maxFrames * STRIDE ) );
		this.frames = 0;
		this.acc = 0;
		this.events = []; // {t, text}
	}
	record( dt ) {
		this.acc += dt;
		if ( this.acc < 1 / RATE ) return;
		this.acc -= 1 / RATE;
		if ( this.frames >= this.maxFrames ) return;
		const f = this.frames * STRIDE;
		for ( let i = 0; i < this.cars.length; i ++ ) {
			const v = this.cars[ i ].vehicle, b = this.buffers[ i ];
			b[ f ] = v.position.x; b[ f + 1 ] = v.position.y; b[ f + 2 ] = v.position.z;
			b[ f + 3 ] = v.quaternion.x; b[ f + 4 ] = v.quaternion.y; b[ f + 5 ] = v.quaternion.z; b[ f + 6 ] = v.quaternion.w;
			b[ f + 7 ] = v.steerAngle; b[ f + 8 ] = v.wheels[ 0 ].spinAngle; b[ f + 9 ] = v.controls.brake > 0.05 ? 1 : 0; b[ f + 10 ] = v.engine.rpm; b[ f + 11 ] = v.speed;
		}
		this.frames ++;
	}
	get duration() { return this.frames / RATE; }
}

export class ReplayPlayer {
	constructor( recorder, cars ) {
		this.rec = recorder; this.cars = cars;
		this.time = 0; this.speed = 1; this.playing = true;
		this.focus = 0;
		this._p = new Vector3(); this._q = new Quaternion(); this._q2 = new Quaternion();
	}
	nextCar() { this.focus = ( this.focus + 1 ) % this.cars.length; }
	get duration() { return this.rec.duration; }
	update( dt ) {
		if ( this.playing ) this.time += dt * this.speed;
		if ( this.time >= this.duration ) { this.time = this.duration - 0.001; this.playing = false; }
		if ( this.time < 0 ) this.time = 0;
		const f = this.time * RATE;
		const i0 = Math.min( this.rec.frames - 1, Math.floor( f ) ), i1 = Math.min( this.rec.frames - 1, i0 + 1 ), t = f - Math.floor( f );
		for ( let c = 0; c < this.cars.length; c ++ ) {
			const b = this.rec.buffers[ c ], a = i0 * STRIDE, d = i1 * STRIDE;
			const car = this.cars[ c ];
			car.root.position.set( b[ a ] + ( b[ d ] - b[ a ] ) * t, b[ a + 1 ] + ( b[ d + 1 ] - b[ a + 1 ] ) * t, b[ a + 2 ] + ( b[ d + 2 ] - b[ a + 2 ] ) * t );
			this._q.set( b[ a + 3 ], b[ a + 4 ], b[ a + 5 ], b[ a + 6 ] ); this._q2.set( b[ d + 3 ], b[ d + 4 ], b[ d + 5 ], b[ d + 6 ] );
			car.root.quaternion.slerpQuaternions( this._q, this._q2, t );
			const steer = b[ a + 7 ], spin = b[ a + 8 ] + ( b[ d + 8 ] - b[ a + 8 ] ) * t;
			for ( const w of car.wheels ) { w.pivot.rotation.y = w.front ? steer : 0; w.spin.rotation.x = spin; }
			car.uniforms.brake.value = b[ a + 9 ];
			car.replaySpeed = b[ a + 11 ]; car.replayRpm = b[ a + 10 ];
		}
	}
	focusCar() { return this.cars[ this.focus ]; }
}
