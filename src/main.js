/**
 * Rush Gear — entry point and game state machine.
 *
 * Fixed-step 120 Hz simulation with render interpolation; all content procedural.
 * States: loading → menu ⇄ race (countdown/racing/finished) ⇄ replay.
 */
import { Vector3, Quaternion, Group, Color } from 'three/webgpu';
import { GameRenderer } from './render/Renderer.js';
import { U } from './render/Uniforms.js';
import { Settings } from './core/Settings.js';
import { Input } from './core/Input.js';
import { bus } from './core/EventBus.js';
import { Track } from './world/Track.js';
import { getTrack, TRACKS } from './world/TrackData.js';
import { makeTrackMaterials } from './render/TrackMaterials.js';
import { Scenery } from './world/Scenery.js';
import { getCar, CARS } from './vehicle/CarData.js';
import { CarBuilder } from './vehicle/CarBuilder.js';
import { Vehicle, DT } from './vehicle/Vehicle.js';
import { RacingLine } from './ai/RacingLine.js';
import { AIDriver, AI_PERSONALITIES } from './ai/AIDriver.js';
import { RaceCamera } from './game/Camera.js';
import { Race } from './game/Race.js';
import { Records } from './game/Records.js';
import { Garage } from './game/Garage.js';
import { ReplayRecorder, ReplayPlayer } from './game/Replay.js';
import { GhostRecorder, GhostPlayer } from './game/Ghost.js';
import { Championship } from './game/Championship.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';
import { formatTime, makeRNG } from './core/math.js';

const _pos = new Vector3(), _quat = new Quaternion();
const hexToLinear = ( hex ) => { const c = new Color( hex ); return [ c.r, c.g, c.b ]; };

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
		this.cars = [];        // {root, chassis, group, wheels, uniforms, body, vehicle, def, ai?}
		this.vehicles = [];
		this.race = null;
		this.track = null;
		this.championship = null;
		this.replay = null;
		this.autopilot = false;
		this.session = null;
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
		const flash = ( text, sub, small, ms ) => { this.hud.center( text, sub, small ); setTimeout( () => { if ( this.hud.el.center.textContent.startsWith( text ) ) this.hud.center( '' ); }, ms ); };
		bus.on( 'race:start', () => flash( 'GO!', '', false, 900 ) );
		bus.on( 'race:lap', ( { entry, time, personalBest } ) => { if ( entry.isPlayer ) this.hud.feed( `Lap ${formatTime( time )}${personalBest ? ' · personal best' : ''}`, personalBest ); } );
		bus.on( 'race:fastest', ( { entry, time } ) => this.hud.feed( `Fastest lap: ${entry.name} ${formatTime( time )}`, true ) );
		bus.on( 'race:record', ( { entry, time } ) => this.hud.feed( `New track record! ${entry.name} ${formatTime( time )}`, true ) );
		bus.on( 'race:overtake', ( { entry, passed, position } ) => { if ( entry.isPlayer || passed.isPlayer || position <= 3 ) this.hud.feed( `${entry.name} passes ${passed.name} for P${position}` ); } );
		bus.on( 'race:finalLap', () => flash( 'FINAL LAP', '', true, 2000 ) );
		bus.on( 'race:finish', ( { entry } ) => { if ( entry.isPlayer ) this.hud.center( 'FINISH', `P${entry.position}`, false ); else this.hud.feed( `${entry.name} finishes P${entry.position}` ); } );
		bus.on( 'race:sector', ( { sector, status, time } ) => { if ( status === 'purple' ) this.hud.feed( `Sector ${sector + 1}: session best ${time.toFixed( 3 )}`, false ); } );
		bus.on( 'race:playerLap', ( e ) => this.onPlayerLap( e ) );
		bus.on( 'race:end', () => this.onRaceEnd() );
	}

	/* ------------------------------------------------------------------------------------------ */
	/* World                                                                                      */
	/* ------------------------------------------------------------------------------------------ */

	buildTrack( trackId ) {
		this.disposeWorld();
		const def = getTrack( trackId );
		this.track = new Track( def );
		this.trackMaterials = makeTrackMaterials( this.track );
		this.track.buildMeshes( this.trackMaterials, this.settings.quality );
		this.gfx.scene.add( this.track.group );
		this.scenery = new Scenery( this.track, this.settings.quality );
		this.gfx.scene.add( this.scenery.group );
		this.hud.setTrack( this.track );
		this.cam.setTracksideCameras( this.track );
		this.gfx.setEnvironment( this.track );
		this.line = new RacingLine( this.track );
	}

	spawnCar( carId, opts ) {
		const def = getCar( carId );
		const vehicle = new Vehicle( def, this.track, opts );
		vehicle.aids = opts.isPlayer ? { ...this.settings.aids } : { abs: true, tc: true, autoGear: true };
		const built = CarBuilder.build( def, { quality: this.settings.quality, ghost: opts.ghost } );
		if ( opts.color ) built.uniforms.color.value.setRGB( ...opts.color );
		else if ( opts.isPlayer && this.garage.paints[ carId ] ) built.uniforms.color.value.setRGB( ...this.garage.paints[ carId ] );
		if ( opts.ghost ) built.uniforms.ghost.value = 1;
		const root = new Group();
		const chassis = built.group;
		chassis.position.y = - def.cgHeight;
		root.add( chassis );
		this.gfx.scene.add( root );
		const car = { root, chassis, ...built, vehicle, def, name: opts.name, color: opts.hex };
		if ( ! opts.ghost ) { this.cars.push( car ); this.vehicles.push( vehicle ); }
		return car;
	}

	disposeWorld() {
		for ( const c of this.cars ) { this.gfx.scene.remove( c.root ); c.root.traverse( ( o ) => o.geometry?.dispose() ); }
		if ( this.ghostCar ) { this.gfx.scene.remove( this.ghostCar.root ); this.ghostCar = null; }
		this.cars.length = 0; this.vehicles.length = 0;
		if ( this.track ) { this.gfx.scene.remove( this.track.group ); this.track.group.traverse( ( o ) => o.geometry?.dispose() ); this.track = null; }
		if ( this.scenery ) { this.gfx.scene.remove( this.scenery.group ); this.scenery.group.traverse( ( o ) => o.geometry?.dispose() ); this.scenery = null; }
		this.race = null; this.replay = null; this.recorder = null; this.ghost = null;
	}

	/**
	 * Build a session: track, player, AI field, grid, race manager, recorders.
	 * @param cfg { trackId, carId, mode: 'race'|'qualifying'|'timetrial', laps, aiCount, gridOrder, timeLimit }
	 */
	setupSession( cfg ) {
		this.session = cfg;
		this.buildTrack( cfg.trackId );
		const rng = makeRNG( 99 + cfg.trackId.length );
		const entries = [];
		const player = this.spawnCar( cfg.carId, { name: 'You', isPlayer: true, id: 0, hex: '#ff3b1f' } );
		this.playerCar = player;
		entries.push( { car: player, name: 'You', isPlayer: true, carName: player.def.name, color: '#ff3b1f' } );
		const aiCount = cfg.aiCount ?? 8;
		for ( let i = 0; i < aiCount; i ++ ) {
			const p = AI_PERSONALITIES[ i % AI_PERSONALITIES.length ];
			const carDef = CARS[ ( i * 2 + 1 ) % CARS.length ];
			const car = this.spawnCar( carDef.id, { name: p.name, isPlayer: false, id: i + 1, color: hexToLinear( p.color ), hex: p.color } );
			const profile = this.line.profileFor( carDef, this.track.def.weather.rain );
			car.ai = new AIDriver( car.vehicle, this.line, profile, p, { seed: 7 + i * 13, difficulty: cfg.difficulty ?? 1 } );
			entries.push( { car, name: p.name, isPlayer: false, carName: carDef.name, color: p.color, ai: car.ai } );
		}
		for ( const c of this.cars ) if ( c.ai ) c.ai.setOthers( this.vehicles );
		// autopilot for the player (attract mode / tests)
		const pProfile = this.line.profileFor( player.def, this.track.def.weather.rain );
		player.autopilot = new AIDriver( player.vehicle, this.line, pProfile, AI_PERSONALITIES[ 0 ], { seed: 1 } );
		player.autopilot.setOthers( this.vehicles );
		// grid order
		let order = entries.slice();
		if ( cfg.gridOrder ) order.sort( ( a, b ) => cfg.gridOrder.indexOf( a.name ) - cfg.gridOrder.indexOf( b.name ) );
		else if ( cfg.mode === 'race' ) { // quick race: player starts mid-pack
			order = entries.filter( ( e ) => ! e.isPlayer ); order.splice( Math.min( 5, order.length ), 0, entries[ 0 ] );
		}
		if ( cfg.mode === 'timetrial' ) order = [ entries[ 0 ] ];
		order.forEach( ( e, i ) => { const slot = this.track.gridSlot( i ); e.car.vehicle.reset( slot.x, slot.y, slot.z, slot.heading, slot.quaternion ); } );
		this.race = new Race( { track: this.track, laps: cfg.laps ?? this.track.def.laps, mode: cfg.mode, records: this.records, timeLimit: cfg.timeLimit ?? 0,
			entries: order.map( ( e ) => ( { vehicle: e.car.vehicle, name: e.name, isPlayer: e.isPlayer, carName: e.carName, color: e.color } ) ) } );
		this.recorder = new ReplayRecorder( this.cars );
		// ghost (time trial)
		if ( cfg.mode === 'timetrial' ) {
			this.ghostRec = new GhostRecorder();
			const data = this.records.loadGhost( cfg.trackId );
			if ( data ) this.setGhost( data );
		}
		this.cam.setMode( this.settings.cameraMode );
		this.cam.initialised = false; this.cam.replay = false;
		this.menu.clear();
		this.hud.show( true );
		this.hud.center( '' );
		this.state = 'race';
		this.paused = false;
		this.accumulator = 0;
		this.lastTime = performance.now();
	}

	setGhost( data ) {
		if ( this.ghostCar ) { this.gfx.scene.remove( this.ghostCar.root ); }
		this.ghostCar = this.spawnCar( data.carId || this.session.carId, { name: 'Ghost', ghost: true, color: [ 0.3, 0.7, 1.0 ] } );
		this.ghost = new GhostPlayer( data, this.ghostCar );
		this.ghostData = data;
		this.hud.feed( `Ghost loaded: ${formatTime( data.lapTime )}` );
	}

	/* ------------------------------------------------------------------------------------------ */
	/* Modes                                                                                      */
	/* ------------------------------------------------------------------------------------------ */

	_withLoading( label, fn ) {
		this.menu.loading( label, 0.3 );
		this.garageOn = false; this.garage.hide();
		setTimeout( () => { try { fn(); } catch ( err ) { console.error( err ); this.menu.toast( 'Failed: ' + err.message ); this.quitToMenu(); } }, 40 );
	}

	startQuickRace( sel ) {
		this._withLoading( 'Generating circuit', () => this.setupSession( { trackId: sel.trackId, carId: sel.carId, mode: 'race', laps: getTrack( sel.trackId ).laps, aiCount: 8 } ) );
	}
	startTimeTrial( sel ) {
		this._withLoading( 'Generating circuit', () => this.setupSession( { trackId: sel.trackId, carId: sel.carId, mode: 'timetrial', aiCount: 0 } ) );
	}
	startChampionship( sel ) {
		const rng = makeRNG( Date.now() % 10000 );
		const others = TRACKS.map( ( t ) => t.id ).filter( ( id ) => id !== sel.trackId ).sort( () => rng() - 0.5 );
		const rounds = [ sel.trackId, others[ 0 ], others[ 1 ] ];
		const drivers = [ { name: 'You', isPlayer: true, color: '#ff3b1f' }, ...AI_PERSONALITIES.map( ( p ) => ( { name: p.name, isPlayer: false, color: p.color } ) ) ];
		this.championship = new Championship( rounds, 'You', drivers );
		this.championshipCar = sel.carId;
		this.championshipNext();
	}
	championshipNext() {
		const ch = this.championship;
		if ( ! ch ) return this.quitToMenu();
		if ( ch.finished ) { this.championship = null; return this.quitToMenu(); }
		if ( ch.stage === 'qualifying' ) {
			this._withLoading( 'Qualifying · ' + getTrack( ch.currentTrack ).name, () => this.setupSession( { trackId: ch.currentTrack, carId: this.championshipCar, mode: 'qualifying', aiCount: 8, timeLimit: 170 } ) );
		} else {
			this._withLoading( `Race ${ch.round + 1} · ` + getTrack( ch.currentTrack ).name, () => this.setupSession( { trackId: ch.currentTrack, carId: this.championshipCar, mode: 'race', laps: getTrack( ch.currentTrack ).laps, aiCount: 8, gridOrder: ch.grid } ) );
		}
	}
	restartRace() { if ( this.session ) { this.menu.clear(); const cfg = this.session; this._withLoading( 'Restarting', () => this.setupSession( cfg ) ); } }
	quitToMenu() {
		this.hud.show( false ); this.menu.clear();
		this.disposeWorld(); this.state = 'menu'; this.paused = false; this.cam.replay = false;
		this.menu.main( this.info );
	}
	applyAids() { for ( const v of this.vehicles ) if ( v.isPlayer ) v.aids = { ...this.settings.aids }; }
	cycleCamera() { this.cam.cycle(); this.settings.cameraMode = this.cam.mode; this.settings.save(); }
	showGarageCar( on, carId ) { if ( on ) { this.garage.show( carId ); this.garageOn = true; } else { this.garage.hide(); this.garageOn = false; } }
	repaintGarageCar() { this.garage.repaint(); }

	onEscape() {
		if ( this.state === 'replay' ) return this.exitReplay();
		if ( this.state === 'race' ) { if ( this.paused ) this.resume(); else this.pause(); }
	}
	pause() { this.paused = true; this.menu.pause(); }
	resume() { this.paused = false; this.menu.clear(); this.lastTime = performance.now(); }

	onPlayerLap( { entry, time, splits } ) {
		if ( this.session?.mode !== 'timetrial' || ! this.ghostRec ) return;
		const prevBest = this.ghostData?.lapTime ?? Infinity;
		if ( this.ghostRec.frames.length > 10 && time < prevBest ) {
			const data = this.ghostRec.toData( time, this.session.carId );
			this.records.saveGhost( this.session.trackId, data );
			this.setGhost( data );
			this.hud.feed( `New ghost: ${formatTime( time )}`, true );
		}
		this.ghostRec.start();
		this.ghost?.reset();
	}

	onRaceEnd() {
		setTimeout( () => {
			if ( this.state !== 'race' || ! this.race?.finished ) return;
			if ( this.championship ) {
				this.championship.submit( this.race );
				if ( this.race.mode === 'qualifying' ) this.menu.results( this.race, null );
				else this.menu.results( this.race, this.championship );
			} else this.menu.results( this.race, null );
		}, this.race?.mode === 'race' ? 2500 : 300 );
	}
	/** Results "Continue" in championship mode. */
	championshipContinue() { this.menu.championshipStandings( this.championship, () => this.championshipNext() ); }

	startReplay() {
		if ( ! this.recorder || this.recorder.frames < 5 ) return this.menu.toast( 'Nothing recorded yet' );
		this.menu.clear();
		this.replay = new ReplayPlayer( this.recorder, this.cars );
		this.replay.focus = this.cars.indexOf( this.playerCar );
		this.state = 'replay';
		this.hud.show( false );
		this.cam.replay = true;
		this.replayBar = this.menu.replayBar( this.replay );
	}
	exitReplay() {
		this.state = 'race';
		this.cam.replay = false;
		this.replay = null;
		this.menu.clear();
		if ( this.race?.finished ) this.onRaceEnd(); else { this.hud.show( true ); this.pause(); }
	}

	/* ------------------------------------------------------------------------------------------ */
	/* Loop                                                                                       */
	/* ------------------------------------------------------------------------------------------ */

	loop( now ) {
		requestAnimationFrame( ( t ) => this.loop( t ) );
		const frameStart = performance.now();
		const dtFrame = Math.min( 0.1, ( now - this.lastTime ) / 1000 );
		this.lastTime = now;
		if ( this.state === 'race' && ! this.paused ) {
			this.accumulator += dtFrame;
			let steps = 0;
			while ( this.accumulator >= DT && steps < 8 ) { this.fixedUpdate( DT ); this.accumulator -= DT; steps ++; }
			if ( steps === 8 ) this.accumulator = 0;
			this.time += dtFrame;
			this.renderFrame( dtFrame, this.accumulator / DT );
		} else if ( this.state === 'race' ) {
			this.renderFrame( 0, 0 );
		} else if ( this.state === 'replay' ) {
			this.time += dtFrame;
			this.replay.update( dtFrame );
			this.renderReplay( dtFrame );
		} else {
			this.renderMenu( dtFrame );
		}
		if ( this.state === 'race' || this.state === 'replay' ) {
			if ( this.input.justPressed( 'KeyC' ) ) this.cycleCamera();
			if ( this.input.justPressed( 'KeyR' ) && this.state === 'race' && ! this.paused ) this.startReplay();
			if ( this.input.justPressed( 'KeyP' ) ) { this.autopilot = ! this.autopilot; this.menu.toast( this.autopilot ? 'Autopilot on' : 'Autopilot off' ); }
		}
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
				if ( this.autopilot && car.autopilot ) car.autopilot.update( dt, race );
				else if ( live ) { c.steer = inp.steer; c.throttle = inp.throttle; c.brake = inp.brake; c.handbrake = inp.handbrake; c.gearUp = inp.gearUp; c.gearDown = inp.gearDown; }
				else { c.steer = inp.steer; c.throttle = 0; c.brake = 0; c.handbrake = 1; }
			} else if ( car.ai ) {
				car.ai.update( dt, race );
				if ( ! live ) { v.controls.throttle = 0; v.controls.brake = 0; v.controls.handbrake = 1; }
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
				if ( col.strength > 0.3 && live ) {
					if ( col.wall ) this.hud.feed( `${car.name} hits the barrier` );
					else if ( col.other && ( v.isPlayer || col.other.isPlayer ) && this.hud ) this.hud.feed( `${car.name} and ${col.other.name} make contact` );
				}
			}
		}
		for ( let i = 0; i < this.vehicles.length; i ++ ) for ( let j = i + 1; j < this.vehicles.length; j ++ ) Vehicle.collide( this.vehicles[ i ], this.vehicles[ j ] );
		if ( race ) {
			race.update( dt );
			if ( race.isCountdown ) { const n = Math.ceil( race.countdown ); this.hud.center( n > 3 ? '' : String( n ) ); }
			if ( live && this.ghostRec ) {
				if ( ! this.ghostRec.active && race.entryOf( this.playerCar.vehicle ).lapsDone === 0 && race.entryOf( this.playerCar.vehicle ).checkpoints === 0 && race.time < 0.1 ) this.ghostRec.start();
				this.ghostRec.record( this.playerCar.vehicle, dt );
				this.ghost?.update( dt );
			}
			this.recorder?.record( dt );
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
			u.head.value = U.night.value > 0.3 || v.proj.tunnel || U.rain.value > 0.3 ? 1 : 0;
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

	renderReplay( dt ) {
		const car = this.replay.focusCar();
		this.cam.update( dt, car.root.position, car.root.quaternion, car.vehicle, this.time );
		this.gfx.updateShadowTarget( car.root.position );
		U.time.value = this.time;
		if ( this.replayBar ) this.replayBar.querySelector( '.t' ).textContent = `${formatTime( this.replay.time )} / ${formatTime( this.replay.duration )} · ${car.name}`;
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
		const c = this.cam.camera;
		c.position.set( Math.sin( this.time * 0.1 ) * 40, 12, Math.cos( this.time * 0.1 ) * 40 );
		c.lookAt( 0, 0, 0 );
		this.gfx.render( c );
	}

	/** Test hook: advance the simulation synchronously (no rendering). */
	simulate( seconds ) {
		if ( this.race && this.race.isCountdown ) this.race.countdown = 0.01;
		const steps = Math.round( seconds / DT );
		for ( let i = 0; i < steps; i ++ ) this.fixedUpdate( DT );
		this.syncCarVisuals( 1 );
		this.cam.initialised = false; // snap the camera to the new position
		this.time += seconds;
	}
}

const game = new Game();
window.RUSHGEAR = game;
game.init().catch( ( err ) => {
	console.error( err );
	document.getElementById( 'ui' ).innerHTML = `<div class="loading"><div class="logo">Rush <em>Gear</em></div><div class="status">Failed to start: ${err.message}</div></div>`;
} );
