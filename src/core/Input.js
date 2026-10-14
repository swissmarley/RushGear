/**
 * Keyboard + gamepad input with analog smoothing.
 * Keyboard steering is ramped so it feels like a wheel rather than a switch.
 */
import { clamp, damp } from './math.js';

export class Input {
	constructor() {
		this.keys = new Set();
		this.pressed = new Set(); // edge-triggered, cleared each frame
		this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0;
		this.gearUp = false; this.gearDown = false;
		this.gamepadIndex = - 1;
		this.rawSteer = 0;
		this.enabled = true;

		window.addEventListener( 'keydown', ( e ) => {
			if ( e.target && ( e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ) ) return;
			if ( ! this.keys.has( e.code ) ) this.pressed.add( e.code );
			this.keys.add( e.code );
			if ( [ 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space' ].includes( e.code ) ) e.preventDefault();
		} );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );
		window.addEventListener( 'gamepadconnected', ( e ) => { this.gamepadIndex = e.gamepad.index; } );
	}

	key( code ) { return this.keys.has( code ); }
	justPressed( code ) { return this.pressed.has( code ); }
	endFrame() { this.pressed.clear(); this.gearUp = false; this.gearDown = false; }

	/** Called from the fixed physics step so steering ramps are frame-rate independent. */
	update( dt ) {
		let steerTarget = 0, throttle = 0, brake = 0, handbrake = 0;
		let steerRate = 4.5; // keyboard ramp speed (units/s)
		if ( this.enabled ) {
			if ( this.key( 'ArrowLeft' ) || this.key( 'KeyA' ) ) steerTarget -= 1;
			if ( this.key( 'ArrowRight' ) || this.key( 'KeyD' ) ) steerTarget += 1;
			if ( this.key( 'ArrowUp' ) || this.key( 'KeyW' ) ) throttle = 1;
			if ( this.key( 'ArrowDown' ) || this.key( 'KeyS' ) ) brake = 1;
			if ( this.key( 'Space' ) ) handbrake = 1;
			if ( this.justPressed( 'ShiftLeft' ) || this.justPressed( 'KeyE' ) ) this.gearUp = true;
			if ( this.justPressed( 'ControlLeft' ) || this.justPressed( 'KeyQ' ) ) this.gearDown = true;

			const gp = this.gamepadIndex >= 0 ? navigator.getGamepads?.()[ this.gamepadIndex ] : null;
			if ( gp ) {
				const ax = gp.axes[ 0 ] || 0;
				if ( Math.abs( ax ) > 0.08 ) { steerTarget = ax; steerRate = 30; }
				const rt = gp.buttons[ 7 ]?.value || 0, lt = gp.buttons[ 6 ]?.value || 0;
				if ( rt > 0.02 ) throttle = rt;
				if ( lt > 0.02 ) brake = lt;
				if ( gp.buttons[ 0 ]?.pressed ) throttle = 1;
				if ( gp.buttons[ 2 ]?.pressed ) brake = 1;
				if ( gp.buttons[ 1 ]?.pressed ) handbrake = 1;
				if ( gp.buttons[ 5 ]?.pressed && ! this._gpUp ) this.gearUp = true;
				if ( gp.buttons[ 4 ]?.pressed && ! this._gpDown ) this.gearDown = true;
				this._gpUp = !! gp.buttons[ 5 ]?.pressed; this._gpDown = !! gp.buttons[ 4 ]?.pressed;
			}
		}
		// Ramp steering toward the target; return to centre faster than winding on.
		const rate = Math.abs( steerTarget ) < Math.abs( this.steer ) ? steerRate * 1.6 : steerRate;
		const d = steerTarget - this.steer;
		this.steer = clamp( this.steer + clamp( d, - rate * dt, rate * dt ), - 1, 1 );
		this.throttle = damp( this.throttle, throttle, 25, dt );
		this.brake = damp( this.brake, brake, 30, dt );
		this.handbrake = handbrake;
	}
}
