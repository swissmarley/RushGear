/**
 * Rush Gear — entry point and game state machine.
 *
 * Fixed-step 120 Hz simulation with render interpolation; all content procedural.
 */
import { Vector3, Quaternion, Group } from 'three/webgpu';
import { GameRenderer } from './render/Renderer.js';
import { U } from './render/Uniforms.js';
import { Settings } from './core/Settings.js';
import { Input } from './core/Input.js';
import { bus } from './core/EventBus.js';
import { Track } from './world/Track.js';
import { getTrack, TRACKS } from './world/TrackData.js';
import { makeTrackMaterials } from './render/TrackMaterials.js';
import { getCar, CARS } from './vehicle/CarData.js';
import { CarBuilder } from './vehicle/CarBuilder.js';
import { Vehicle, DT } from './vehicle/Vehicle.js';
import { RaceCamera } from './game/Camera.js';
import { Race } from './game/Race.js';
import { Records } from './game/Records.js';
import { Garage } from './game/Garage.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';
import { formatTime } from './core/math.js';

const _pos = new Vector3(), _quat = new Quaternion();

class Game {
	constructor() {
		this.canvas = document.getElementById( 'gl' );
		this.uiRoot = document.getElementById( 'ui' );
		this.settings = new Settings();
		this.input = new Input();
		this.records = new Records();
		this.menu = new Menu( this.uiRoot, this );
		this.state = 'loading';
		this.accumulator = 0;
		this.lastTime = performance.now();
		this.time = 0;
		this.paused = false;
		this.cars = [];      // visual car instances {group, wheels, uniforms, vehicle}
		this.vehicles = [];
		this.race = null;
		this.track = null;
	}

	get info() { return { backend: this.gfx?.backend || '—' }; }

	async init() {
		this.menu.loading( 'Initialising renderer', 0.1 );
		this.gfx = new GameRenderer( this.canvas, this.settings );
		await this.gfx.init();
		this.hud = new HUD( this.uiRoot );
		this.cam = new RaceCamera( window.innerWidth / window.innerHeight );
		this.garage = new Garage( this.settings.quality );
		this.gfx.onResize = ( aspect ) => { this.cam.resize( aspect ); this.garage.resize( aspect ); };
		this.garage.resize( window.innerWidth / window.innerHeight );
		this.settings.onChange = ( q ) => this.gfx.applyQuality( q );
		this._bindEvents();
		this.state = 'menu';
		this.menu.main( this.info );
		requestAnimationFrame( ( t ) => this.loop( t ) );
	}

	_bindEvents() {
		bus.on( 'race:start', () => this.hud.center( 'GO!', '', false ) && setTimeout( () => this.hud.center( '' ), 900 ) );
		bus.on( 'race:lap', ( { entry, time, personalBest } ) => { if ( entry.isPlayer ) this.hud.feed( `Lap ${formatTime( time )}${personalBest ? ' · personal best' : ''}` ); } );
		bus.on( 'race:fastest', ( { entry, time } ) => this.hud.feed( `Fastest lap: ${entry.name} ${formatTime( time )}`, true ) );
		bus.on( 'race:record', ( { entry, time } ) => this.hud.feed( `New track record! ${entry.name} ${formatTime( time )}`, true ) );
		bus.on( 'race:overtake', ( { entry, passed, position } ) => { if ( entry.isPlayer || passed.isPlayer ) this.hud.feed( `${entry.name} overtakes ${passed.name} for P${position}` ); } );
		bus.on( 'race:finalLap', () => this.hud.center( 'FINAL LAP', '', true ) && setTimeout( () => this.hud.center( '' ), 2000 ) );
		bus.on( 'race:finish', ( { entry } ) => { if ( entry.isPlayer ) { this.hud.center( 'FINISH', `P${entry.position}`, false ); } else this.hud.feed( `${entry.name} finishes P${entry.position}` ); } );
		bus.on( 'race:end', () => this.onRaceEnd() );
	}

	/* ---------------- world construction ---------------- */

	buildTrack( trackId ) {
		this.disposeWorld();
		const def = getTrack( trackId );
		this.track = new Track( def );
		this.trackMaterials = makeTrackMaterials( this.track );
		this.track.buildMeshes( this.trackMaterials, this.settings.quality );
		this.gfx.scene.add( this.track.group );
		this.hud.setTrack( this.track );
		this.cam.setTracksideCameras( this.track );
		// sun & sky for the biome (placeholder until the day/night system)
		U.skyZenith.value.setRGB( 0.18, 0.4, 0.85 ); U.skyHorizon.value.setRGB( 0.72, 0.82, 0.92 );
		U.sunDir.value.set( 0.5, 0.75, 0.3 ).normalize();
	}

	spawnCar( carId, opts ) {
		const def = getCar( carId );
		const vehicle = new Vehicle( def, this.track, opts );
		vehicle.aids = { ...this.settings.aids };
		const built = CarBuilder.build( def, { quality: this.settings.quality } );
		const paint = this.garage.paints[ carId ];
		if ( paint && opts.isPlayer ) built.uniforms.color.value.setRGB( ...paint );
		const root = new Group();
		const chassis = built.group;
		chassis.position.y = - def.cgHeight;
		root.add( chassis );
		this.gfx.scene.add( root );
		const car = { root, chassis, ...built, vehicle, def };
		this.cars.push( car ); this.vehicles.push( vehicle );
		return car;
	}

	disposeWorld() {
		for ( const c of this.cars ) this.gfx.scene.remove( c.root );
		this.cars.length = 0; this.vehicles.length = 0;
		if ( this.track ) { this.gfx.scene.remove( this.track.group ); this.track.group.traverse( ( o ) => o.geometry?.dispose() ); this.track = null; }
		this.race = null;
	}

	/* ---------------- modes ---------------- */

	startQuickRace( sel ) {
		this.menu.loading( 'Generating circuit', 0.3 );
		setTimeout( () => {
			this.buildTrack( sel.trackId );
			const player = this.spawnCar( sel.carId, { name: 'You', isPlayer: true, id: 0 } );
			const slot = this.track.gridSlot( 0 );
			player.vehicle.reset( slot.x, slot.y, slot.z, slot.heading, slot.quaternion );
			this.race = new Race( { track: this.track, laps: sel.laps ?? this.track.def.laps, mode: 'race', records: this.records,
				entries: [ { vehicle: player.vehicle, name: 'You', isPlayer: true, carName: player.def.name, color: '#ff3b1f' } ] } );
			this.playerCar = player;
			this.cam.setMode( this.settings.cameraMode );
			this.cam.initialised = false;
			this.menu.clear();
			this.hud.show( true );
			this.state = 'race';
			this.paused = false;
		}, 30 );
	}
	startChampionship() { this.menu.toast( 'Championship arrives in a later build' ); }
	startTimeTrial() { this.menu.toast( 'Time Trial arrives in a later build' ); }
	showGarageCar( on, carId ) { if ( on ) { this.garage.show( carId ); this.garageOn = true; } else { this.garage.hide(); this.garageOn = false; } }
	repaintGarageCar() { this.garage.repaint(); }
	applyAids() { for ( const v of this.vehicles ) if ( v.isPlayer ) v.aids = { ...this.settings.aids }; }
	cycleCamera() { this.cam.cycle(); this.settings.cameraMode = this.cam.mode; this.settings.save(); }
	startReplay() { this.menu.toast( 'Replay arrives in a later build' ); }
	exitReplay() {}
	championshipNext() {}

	onEscape() {
		if ( this.state === 'race' ) { if ( this.paused ) this.resume(); else this.pause(); }
	}
	pause() { this.paused = true; this.menu.pause(); }
	resume() { this.paused = false; this.menu.clear(); this.lastTime = performance.now(); }
	restartRace() { const sel = this.menu.selection; this.menu.clear(); this.startQuickRace( sel ); }
	quitToMenu() { this.hud.show( false ); this.disposeWorld(); this.state = 'menu'; this.paused = false; this.menu.main( this.info ); }
	onRaceEnd() { setTimeout( () => { if ( this.state === 'race' && this.race?.finished ) this.menu.results( this.race, null ); }, 2500 ); }

	/* ---------------- loop ---------------- */

	loop( now ) {
		requestAnimationFrame( ( t ) => this.loop( t ) );
		const frameStart = performance.now();
		let dtFrame = Math.min( 0.1, ( now - this.lastTime ) / 1000 );
		this.lastTime = now;
		if ( this.state === 'race' && ! this.paused ) {
			this.accumulator += dtFrame;
			let steps = 0;
			while ( this.accumulator >= DT && steps < 8 ) { this.fixedUpdate( DT ); this.accumulator -= DT; steps ++; }
			if ( steps === 8 ) this.accumulator = 0;
			this.time += dtFrame;
			this.renderFrame( dtFrame, this.accumulator / DT );
		} else if ( this.state === 'race' && this.paused ) {
			this.renderFrame( 0, 0 );
		} else {
			this.renderMenu( dtFrame );
		}
		if ( this.input.justPressed( 'KeyC' ) && this.state === 'race' ) this.cycleCamera();
		this.input.endFrame();
		this.settings.recordFrame( performance.now() - frameStart );
	}

	fixedUpdate( dt ) {
		this.input.update( dt );
		const race = this.race;
		const live = race && race.started;
		for ( const car of this.cars ) {
			const v = car.vehicle;
			if ( v.isPlayer ) {
				const c = v.controls, inp = this.input;
				if ( live ) { c.steer = inp.steer; c.throttle = inp.throttle; c.brake = inp.brake; c.handbrake = inp.handbrake; c.gearUp = inp.gearUp; c.gearDown = inp.gearDown; }
				else { c.steer = inp.steer; c.throttle = 0; c.brake = 0; c.handbrake = 1; }
			}
			v.step( dt, { wetness: U.wetness.value } );
			for ( const col of v.collisions ) {
				if ( v.isPlayer ) this.cam.addShake( col.strength * 0.8 );
				if ( col.strength > 0.25 ) {
					_pos.copy( col.point ).sub( v.position ).applyQuaternion( _quat.copy( v.quaternion ).invert() );
					_pos.y += v.def.cgHeight;
					CarBuilder.dent( car, _pos, col.strength );
				}
				car.uniforms.damage.value = v.damage;
			}
		}
		for ( let i = 0; i < this.vehicles.length; i ++ ) for ( let j = i + 1; j < this.vehicles.length; j ++ ) Vehicle.collide( this.vehicles[ i ], this.vehicles[ j ] );
		if ( race ) {
			race.update( dt );
			if ( race.isCountdown ) { const n = Math.ceil( race.countdown ); this.hud.center( n > 3 ? '' : String( n ) ); }
		}
	}

	syncCarVisuals( alpha ) {
		for ( const car of this.cars ) {
			const v = car.vehicle;
			v.getRenderTransform( alpha, _pos, _quat );
			car.root.position.copy( _pos );
			car.root.quaternion.copy( _quat );
			const staticComp = ( v.mass * 9.81 / 4 ) / v.def.suspension.k;
			for ( let i = 0; i < 4; i ++ ) {
				const w = v.wheels[ i ], vis = car.wheels[ i ];
				vis.pivot.position.y = v.def.wheelRadius + ( w.compression - staticComp );
				vis.pivot.rotation.y = w.front ? v.steerAngle : 0;
				vis.spin.rotation.x = w.spinAngle;
			}
			const u = car.uniforms;
			u.brake.value = v.controls.brake > 0.05 || v.controls.handbrake > 0 ? 1 : 0;
			u.reverse.value = v.engine.gear === - 1 ? 1 : 0;
			u.head.value = U.night.value > 0.3 || v.proj.tunnel ? 1 : 0;
		}
	}

	renderFrame( dt, alpha ) {
		this.syncCarVisuals( alpha );
		const pc = this.playerCar;
		if ( pc ) {
			this.cam.update( dt, pc.root.position, pc.root.quaternion, pc.vehicle, this.time );
			this.gfx.updateShadowTarget( pc.root.position );
		}
		U.time.value = this.time;
		this.hud.update( { vehicle: pc.vehicle, race: this.race, backend: this.gfx.backend, quality: this.settings.quality.preset + ( this.settings.adaptiveLevel ? ` -${this.settings.adaptiveLevel}` : '' ) }, dt );
		this.gfx.render( this.cam.camera );
	}

	renderMenu( dt ) {
		this.time += dt;
		U.time.value = this.time;
		if ( this.garageOn ) {
			this.garage.update( dt, this.time );
			this.gfx.renderer.render( this.garage.scene, this.garage.camera );
			return;
		}
		// idle: slow orbit above the void (track not built yet in the menu)
		const c = this.cam.camera;
		c.position.set( Math.sin( this.time * 0.1 ) * 40, 12, Math.cos( this.time * 0.1 ) * 40 );
		c.lookAt( 0, 0, 0 );
		this.gfx.render( c );
	}
}

const game = new Game();
window.RUSHGEAR = game;
game.init().catch( ( err ) => {
	console.error( err );
	document.getElementById( 'ui' ).innerHTML = `<div class="loading"><div class="logo">Rush <em>Gear</em></div><div class="status">Failed to start: ${err.message}</div></div>`;
} );
