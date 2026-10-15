/**
 * Fully synthesised audio (Web Audio API, no samples):
 *   • engine: harmonic oscillator stack at the firing frequency + sub/2nd-order layers,
 *     intake/exhaust noise, waveshaper distortion by load, rev limiter cut, turbo whistle
 *   • wind, tyre screech, kerb rumble, gravel/grass noise, impacts, scrapes
 *   • opponents: pooled simplified engines with 3D panning, distance roll-off and Doppler
 *   • crowd, rain
 *   • dynamic music from a step sequencer (kick/snare/hats, bass, arp, pads) that follows race state
 */
import { clamp, lerp, damp, makeRNG } from '../core/math.js';

const SURFACE_KERB = 1, SURFACE_GRASS = 2, SURFACE_GRAVEL = 3, SURFACE_SAND = 4;

function makeNoiseBuffer( ctx, seconds = 2, pink = false ) {
	const len = Math.floor( ctx.sampleRate * seconds );
	const buf = ctx.createBuffer( 1, len, ctx.sampleRate );
	const d = buf.getChannelData( 0 );
	let b0 = 0, b1 = 0, b2 = 0;
	for ( let i = 0; i < len; i ++ ) {
		const w = Math.random() * 2 - 1;
		if ( pink ) { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526; d[ i ] = ( b0 + b1 + b2 + w * 0.1848 ) * 0.2; }
		else d[ i ] = w;
	}
	return buf;
}
function noiseSource( ctx, buffer ) {
	const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.start(); return s;
}
function shaperCurve( amount ) {
	const n = 1024, c = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) { const x = i / ( n - 1 ) * 2 - 1; c[ i ] = ( 1 + amount ) * x / ( 1 + amount * Math.abs( x ) ); }
	return c;
}

/* ---------------------------------------------------------------------------------------------- */
/* Engine voice                                                                                   */
/* ---------------------------------------------------------------------------------------------- */
class EngineVoice {
	constructor( ctx, out, def, detailed = true ) {
		this.ctx = ctx; this.def = def; this.detailed = detailed;
		this.gain = ctx.createGain(); this.gain.gain.value = 0;
		this.shaper = ctx.createWaveShaper(); this.shaper.curve = shaperCurve( 6 ); this.shaper.oversample = '2x';
		this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 1500; this.lp.Q.value = 0.8;
		this.body = ctx.createBiquadFilter(); this.body.type = 'peaking'; this.body.frequency.value = 180; this.body.Q.value = 1.2; this.body.gain.value = 6;
		this.shaper.connect( this.lp ); this.lp.connect( this.body ); this.body.connect( this.gain ); this.gain.connect( out );
		// harmonic stack: firing frequency with a bright, uneven harmonic series (engine "burble")
		const cyl = def.engine.cylinders;
		const harm = new Float32Array( 16 ), ph = new Float32Array( 16 );
		for ( let k = 1; k < 16; k ++ ) harm[ k ] = ( 1 / k ) * ( k % 2 === 1 ? 1 : 0.55 ) * ( k % cyl === 0 ? 1.5 : 1 );
		this.wave = ctx.createPeriodicWave( ph, harm, { disableNormalization: false } );
		this.layers = [];
		const mk = ( mult, type, g ) => {
			const o = ctx.createOscillator();
			if ( type === 'custom' ) o.setPeriodicWave( this.wave ); else o.type = type;
			const gn = ctx.createGain(); gn.gain.value = g; o.connect( gn ); gn.connect( this.shaper ); o.start();
			this.layers.push( { o, gn, mult, base: g } );
		};
		mk( 1, 'custom', 0.5 );
		mk( 0.5, 'sine', 0.35 );
		if ( detailed ) { mk( 2, 'sawtooth', 0.12 ); mk( 1.5, 'triangle', 0.08 ); mk( 3, 'square', 0.04 ); }
		// intake / exhaust noise
		this.noise = noiseSource( ctx, makeNoiseBuffer( ctx, 1.5 ) );
		this.nFilter = ctx.createBiquadFilter(); this.nFilter.type = 'bandpass'; this.nFilter.Q.value = 1.5;
		this.nGain = ctx.createGain(); this.nGain.gain.value = 0;
		this.noise.connect( this.nFilter ); this.nFilter.connect( this.nGain ); this.nGain.connect( this.shaper );
		// turbo whistle (I4 turbo only)
		if ( detailed && def.engine.power.toLowerCase().includes( 'turbo' ) ) {
			this.turbo = ctx.createOscillator(); this.turbo.type = 'sine'; this.turboGain = ctx.createGain(); this.turboGain.gain.value = 0;
			this.turbo.connect( this.turboGain ); this.turboGain.connect( out ); this.turbo.start();
		}
		this.rpm = def.engine.idle; this.load = 0;
	}
	update( rpm, load, limiter, dt, volume = 1, pitchScale = 1 ) {
		const ctx = this.ctx, t = ctx.currentTime;
		this.rpm = damp( this.rpm, rpm, 30, dt );
		this.load = damp( this.load, load, 20, dt );
		const f = this.rpm / 60 * this.def.engine.cylinders / 2 * pitchScale;
		for ( const l of this.layers ) {
			l.o.frequency.setTargetAtTime( f * l.mult, t, 0.01 );
			const hi = clamp( ( this.rpm - 2000 ) / 6000, 0, 1 );
			l.gn.gain.setTargetAtTime( l.base * ( l.mult >= 2 ? 0.3 + hi * 1.0 : 1 ), t, 0.02 );
		}
		const rev = clamp( ( this.rpm - this.def.engine.idle ) / ( this.def.engine.redline - this.def.engine.idle ), 0, 1 );
		this.lp.frequency.setTargetAtTime( 400 + this.load * 2800 + rev * 2500, t, 0.03 );
		this.shaper.curve = this._curve || ( this._curve = shaperCurve( 6 ) );
		this.nFilter.frequency.setTargetAtTime( 250 + f * 2.5, t, 0.03 );
		this.nGain.gain.setTargetAtTime( 0.12 + this.load * 0.35 + rev * 0.1, t, 0.03 );
		const cut = limiter ? 0.35 : 1;
		const g = ( 0.25 + this.load * 0.55 + rev * 0.2 ) * volume * cut;
		this.gain.gain.setTargetAtTime( g * 0.55, t, 0.02 );
		if ( this.turbo ) { this.turbo.frequency.setTargetAtTime( 800 + rev * 2600, t, 0.05 ); this.turboGain.gain.setTargetAtTime( this.load * rev * 0.02 * volume, t, 0.05 ); }
	}
	setPan( panner, x, y, z ) { if ( panner ) { panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; } }
	disconnect() { try { this.gain.disconnect(); for ( const l of this.layers ) l.o.stop(); this.noise.stop(); this.turbo?.stop(); } catch { /* */ } }
}

/* ---------------------------------------------------------------------------------------------- */
/* Music sequencer                                                                                */
/* ---------------------------------------------------------------------------------------------- */
class Music {
	constructor( ctx, out ) {
		this.ctx = ctx; this.out = out;
		this.gain = ctx.createGain(); this.gain.gain.value = 0.5; this.gain.connect( out );
		this.bpm = 126; this.step = 0; this.nextTime = 0; this.playing = false;
		this.intensity = 0; // 0 menu, 1 race, 2 final lap
		this.rng = makeRNG( 7 );
		this.noise = makeNoiseBuffer( ctx, 1 );
		// A minor-ish progression, 4 bars of 16 steps
		this.chords = [ [ 57, 60, 64 ], [ 53, 57, 60 ], [ 55, 59, 62 ], [ 52, 55, 59 ] ];
		this.bassPattern = [ 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0 ];
		this.timer = null;
		this.padVoices = [];
	}
	start() { if ( this.playing ) return; this.playing = true; this.nextTime = this.ctx.currentTime + 0.1; this.step = 0; this.timer = setInterval( () => this._schedule(), 25 ); }
	stop() { this.playing = false; clearInterval( this.timer ); for ( const v of this.padVoices ) { try { v.o.stop(); } catch { /* */ } } this.padVoices = []; }
	setIntensity( i ) { this.intensity = i; }
	_schedule() {
		const look = 0.12;
		while ( this.nextTime < this.ctx.currentTime + look ) {
			this._playStep( this.step, this.nextTime );
			this.nextTime += 60 / this.bpm / 4;
			this.step = ( this.step + 1 ) % 64;
		}
	}
	_osc( type, freq, t, dur, gain, filterFreq = 8000, attack = 0.005 ) {
		const ctx = this.ctx;
		const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
		const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq; f.Q.value = 2;
		const g = ctx.createGain(); g.gain.setValueAtTime( 0, t ); g.gain.linearRampToValueAtTime( gain, t + attack ); g.gain.exponentialRampToValueAtTime( 0.0001, t + dur );
		o.connect( f ); f.connect( g ); g.connect( this.gain ); o.start( t ); o.stop( t + dur + 0.05 );
		return { o, f, g };
	}
	_noiseHit( t, dur, gain, hp = 2000, bp = null ) {
		const ctx = this.ctx;
		const s = ctx.createBufferSource(); s.buffer = this.noise;
		const f = ctx.createBiquadFilter(); f.type = bp ? 'bandpass' : 'highpass'; f.frequency.value = bp || hp; f.Q.value = bp ? 1.0 : 0.7;
		const g = ctx.createGain(); g.gain.setValueAtTime( gain, t ); g.gain.exponentialRampToValueAtTime( 0.0001, t + dur );
		s.connect( f ); f.connect( g ); g.connect( this.gain ); s.start( t ); s.stop( t + dur + 0.02 );
	}
	_playStep( step, t ) {
		const bar = Math.floor( step / 16 ), s16 = step % 16;
		const chord = this.chords[ bar % 4 ];
		const midi = ( n ) => 440 * Math.pow( 2, ( n - 69 ) / 12 );
		const inten = this.intensity;
		// pads on every bar (always)
		if ( s16 === 0 ) {
			for ( const v of this.padVoices ) { try { v.g.gain.setTargetAtTime( 0.0001, t, 0.3 ); v.o.stop( t + 1.5 ); } catch { /* */ } }
			this.padVoices = [];
			for ( const n of chord ) for ( const det of [ - 6, 6 ] ) {
				const v = this._osc( 'sawtooth', midi( n ) * Math.pow( 2, det / 1200 ), t, 60 / this.bpm * 4.2, 0.035, 900 + inten * 600, 0.4 );
				this.padVoices.push( v );
			}
		}
		if ( inten >= 1 ) {
			// kick
			if ( s16 % 4 === 0 || ( inten >= 2 && s16 === 14 ) ) {
				const k = this._osc( 'sine', 150, t, 0.25, 0.9, 400 );
				k.o.frequency.setValueAtTime( 150, t ); k.o.frequency.exponentialRampToValueAtTime( 42, t + 0.12 );
			}
			// snare / clap
			if ( s16 === 4 || s16 === 12 ) { this._noiseHit( t, 0.18, 0.5, null, 1800 ); this._osc( 'triangle', 190, t, 0.12, 0.3 ); }
			// hats
			if ( s16 % 2 === 0 ) this._noiseHit( t, 0.05, 0.14, 7000 ); else if ( inten >= 2 ) this._noiseHit( t, 0.03, 0.08, 9000 );
			// bass
			if ( this.bassPattern[ s16 ] ) this._osc( 'sawtooth', midi( chord[ 0 ] - 24 ), t, 0.22, 0.35, 350 + inten * 250 );
			// arpeggio
			const arpNote = chord[ ( s16 + bar ) % 3 ] + 12 * ( s16 % 8 < 4 ? 0 : 1 );
			if ( s16 % 2 === 0 || inten >= 2 ) this._osc( 'square', midi( arpNote ), t, 0.12, 0.07, 1800 + inten * 800 );
			// lead stab every 2 bars on intensity 2
			if ( inten >= 2 && s16 === 8 ) for ( const n of chord ) this._osc( 'sawtooth', midi( n + 12 ), t, 0.4, 0.08, 2500 );
		} else {
			// menu: sparse arp
			if ( s16 % 4 === 0 ) this._osc( 'triangle', midi( chord[ ( s16 / 4 ) % 3 ] + 12 ), t, 0.6, 0.08, 1500, 0.05 );
		}
	}
}

/* ---------------------------------------------------------------------------------------------- */
/* Main audio engine                                                                              */
/* ---------------------------------------------------------------------------------------------- */
export class AudioEngine {
	constructor() {
		this.ctx = null; this.ready = false; this.enabled = true;
		this.volume = 0.8; this.musicVolume = 0.5;
		this.aiVoices = new Map();
		const start = () => { this.init(); window.removeEventListener( 'pointerdown', start ); window.removeEventListener( 'keydown', start ); };
		window.addEventListener( 'pointerdown', start ); window.addEventListener( 'keydown', start );
	}

	init() {
		if ( this.ctx ) { if ( this.ctx.state === 'suspended' ) this.ctx.resume(); return; }
		const ctx = this.ctx = new ( window.AudioContext || window.webkitAudioContext )();
		this.master = ctx.createGain(); this.master.gain.value = this.volume;
		this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = - 12; this.comp.ratio.value = 4; this.comp.attack.value = 0.003; this.comp.release.value = 0.2;
		this.master.connect( this.comp ); this.comp.connect( ctx.destination );
		this.sfx = ctx.createGain(); this.sfx.connect( this.master );
		this.white = makeNoiseBuffer( ctx, 2 ); this.pink = makeNoiseBuffer( ctx, 2, true );
		// wind
		this.wind = noiseSource( ctx, this.pink ); this.windF = ctx.createBiquadFilter(); this.windF.type = 'lowpass'; this.windF.frequency.value = 300; this.windG = ctx.createGain(); this.windG.gain.value = 0;
		this.wind.connect( this.windF ); this.windF.connect( this.windG ); this.windG.connect( this.sfx );
		// tyre screech: noise bandpass + squeal oscillator
		this.screech = noiseSource( ctx, this.white ); this.screechF = ctx.createBiquadFilter(); this.screechF.type = 'bandpass'; this.screechF.frequency.value = 1500; this.screechF.Q.value = 2.5; this.screechG = ctx.createGain(); this.screechG.gain.value = 0;
		this.screech.connect( this.screechF ); this.screechF.connect( this.screechG ); this.screechG.connect( this.sfx );
		this.squeal = ctx.createOscillator(); this.squeal.type = 'sawtooth'; this.squeal.frequency.value = 900; this.squealF = ctx.createBiquadFilter(); this.squealF.type = 'bandpass'; this.squealF.frequency.value = 1800; this.squealF.Q.value = 6; this.squealG = ctx.createGain(); this.squealG.gain.value = 0;
		this.squeal.connect( this.squealF ); this.squealF.connect( this.squealG ); this.squealG.connect( this.sfx ); this.squeal.start();
		// surfaces: rumble (kerb) and gravel/grass
		this.rumble = noiseSource( ctx, this.pink ); this.rumbleF = ctx.createBiquadFilter(); this.rumbleF.type = 'lowpass'; this.rumbleF.frequency.value = 160; this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
		this.rumbleLFO = ctx.createOscillator(); this.rumbleLFO.type = 'square'; this.rumbleLFO.frequency.value = 20; this.rumbleLFOG = ctx.createGain(); this.rumbleLFOG.gain.value = 0.5;
		this.rumbleLFO.connect( this.rumbleLFOG ); this.rumbleLFOG.connect( this.rumbleG.gain ); this.rumbleLFO.start();
		this.rumble.connect( this.rumbleF ); this.rumbleF.connect( this.rumbleG ); this.rumbleG.connect( this.sfx );
		this.gravel = noiseSource( ctx, this.white ); this.gravelF = ctx.createBiquadFilter(); this.gravelF.type = 'bandpass'; this.gravelF.frequency.value = 900; this.gravelF.Q.value = 0.6; this.gravelG = ctx.createGain(); this.gravelG.gain.value = 0;
		this.gravel.connect( this.gravelF ); this.gravelF.connect( this.gravelG ); this.gravelG.connect( this.sfx );
		// crowd
		this.crowd = noiseSource( ctx, this.pink ); this.crowdF = ctx.createBiquadFilter(); this.crowdF.type = 'bandpass'; this.crowdF.frequency.value = 700; this.crowdF.Q.value = 0.5; this.crowdG = ctx.createGain(); this.crowdG.gain.value = 0;
		this.crowd.connect( this.crowdF ); this.crowdF.connect( this.crowdG ); this.crowdG.connect( this.sfx );
		// rain
		this.rain = noiseSource( ctx, this.white ); this.rainF = ctx.createBiquadFilter(); this.rainF.type = 'highpass'; this.rainF.frequency.value = 2500; this.rainG = ctx.createGain(); this.rainG.gain.value = 0;
		this.rain.connect( this.rainF ); this.rainF.connect( this.rainG ); this.rainG.connect( this.sfx );
		// music
		this.music = new Music( ctx, this.master ); this.music.gain.gain.value = this.musicVolume;
		this.music.start();
		this.ready = true;
		this.listener = ctx.listener;
	}

	setVolumes( v, m ) { this.volume = v; this.musicVolume = m; if ( this.master ) this.master.gain.value = v; if ( this.music ) this.music.gain.gain.value = m; }
	setMusicIntensity( i ) { this.music?.setIntensity( i ); }

	/** Player engine voice (recreated per car). */
	setPlayerCar( def ) {
		if ( ! this.ready ) { this._pendingDef = def; return; }
		this.playerVoice?.disconnect();
		this.playerVoice = new EngineVoice( this.ctx, this.sfx, def, true );
	}

	/** Called every rendered frame with the player's vehicle, the camera and the other cars. */
	update( dt, vehicle, camera, cars, race, env = {} ) {
		if ( ! this.ready || ! this.enabled ) return;
		if ( this._pendingDef ) { this.setPlayerCar( this._pendingDef ); this._pendingDef = null; }
		const ctx = this.ctx, t = ctx.currentTime;
		if ( ! vehicle ) {
			this.playerVoice?.update( 0, 0, false, dt, 0 );
			this.windG.gain.setTargetAtTime( 0, t, 0.1 ); this.screechG.gain.setTargetAtTime( 0, t, 0.1 ); this.squealG.gain.setTargetAtTime( 0, t, 0.1 ); this.rumbleG.gain.setTargetAtTime( 0, t, 0.1 ); this.gravelG.gain.setTargetAtTime( 0, t, 0.1 ); this.crowdG.gain.setTargetAtTime( 0, t, 0.2 ); this.rainG.gain.setTargetAtTime( 0, t, 0.2 );
			for ( const [ , v ] of this.aiVoices ) v.voice.update( 0, 0, false, dt, 0 );
			return;
		}
		// listener at the camera
		const L = this.listener;
		if ( L.positionX ) {
			L.positionX.setTargetAtTime( camera.position.x, t, 0.02 ); L.positionY.setTargetAtTime( camera.position.y, t, 0.02 ); L.positionZ.setTargetAtTime( camera.position.z, t, 0.02 );
			const f = camera.getWorldDirection( this._fwd || ( this._fwd = { x: 0, y: 0, z: 0, set() {}, clone() {}, copy() {} } ) );
		}
		// player engine
		const e = vehicle.engine;
		this.playerVoice?.update( e.rpm, e.load, e.limiter > 0, dt, 1 );
		// wind
		const sp = vehicle.speed;
		this.windG.gain.setTargetAtTime( clamp( sp / 70, 0, 1 ) ** 2 * 0.5, t, 0.1 );
		this.windF.frequency.setTargetAtTime( 200 + sp * 25, t, 0.1 );
		// tyres
		let skid = 0, kerb = 0, loose = 0, slipFreq = 0;
		for ( const w of vehicle.wheels ) {
			if ( ! w.onGround ) continue;
			if ( w.surface === 0 || w.surface === 5 ) { skid = Math.max( skid, w.skid ); slipFreq += Math.abs( w.slipVel ); }
			if ( w.surface === SURFACE_KERB ) kerb += 0.25;
			if ( w.surface === SURFACE_GRAVEL || w.surface === SURFACE_SAND || w.surface === SURFACE_GRASS ) loose += 0.25;
		}
		const wet = env.wetness || 0;
		const screechLevel = clamp( skid * 1.3, 0, 1 ) * clamp( sp / 8, 0, 1 ) * ( 1 - wet * 0.6 );
		this.screechG.gain.setTargetAtTime( screechLevel * 0.35, t, 0.03 );
		this.screechF.frequency.setTargetAtTime( 900 + slipFreq * 40 + ( wet ? 300 : 0 ), t, 0.05 );
		this.squealG.gain.setTargetAtTime( Math.max( 0, screechLevel - 0.3 ) * 0.08, t, 0.03 );
		this.squeal.frequency.setTargetAtTime( 700 + skid * 500 + Math.sin( t * 17 ) * 60, t, 0.05 );
		this.rumbleG.gain.setTargetAtTime( kerb * clamp( sp / 15, 0, 1 ) * 0.5, t, 0.03 );
		this.rumbleLFO.frequency.setTargetAtTime( 8 + sp * 0.9, t, 0.05 );
		this.gravelG.gain.setTargetAtTime( loose * clamp( sp / 15, 0, 1 ) * 0.35, t, 0.05 );
		this.gravelF.frequency.setTargetAtTime( 500 + sp * 20, t, 0.05 );
		// crowd near the start/finish straight
		const s = vehicle.proj.s, Lt = vehicle.track.length;
		const dStart = Math.min( s, Lt - s );
		this.crowdG.gain.setTargetAtTime( clamp( 1 - dStart / 220, 0, 1 ) * 0.22 * ( 0.7 + 0.3 * Math.sin( t * 0.7 ) ) * ( race?.started ? 1 : 1.3 ), t, 0.3 );
		// rain (muted inside tunnels)
		this.rainG.gain.setTargetAtTime( ( env.rain || 0 ) * ( vehicle.proj.tunnel ? 0.1 : 0.25 ), t, 0.3 );
		// collisions
		for ( const col of vehicle.collisions ) this.impact( col.strength );
		// opponents: pooled voices for the 3 closest cars
		if ( cars ) this._updateOpponents( dt, vehicle, camera, cars );
		// music intensity by race state
		if ( race ) { const me = race.entryOf( vehicle ); this.music.setIntensity( ! race.started ? 1 : ( me && me.lap >= race.laps && race.mode === 'race' ) ? 2 : 1 ); }
	}

	_updateOpponents( dt, player, camera, cars ) {
		const near = cars.filter( ( c ) => c.vehicle !== player ).map( ( c ) => ( { c, d: c.root.position.distanceTo( camera.position ) } ) ).sort( ( a, b ) => a.d - b.d ).slice( 0, 3 );
		const keep = new Set();
		for ( const { c, d } of near ) {
			keep.add( c );
			let rec = this.aiVoices.get( c );
			if ( ! rec ) {
				const panner = this.ctx.createPanner(); panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse'; panner.refDistance = 6; panner.rolloffFactor = 1.2; panner.maxDistance = 200;
				panner.connect( this.sfx );
				rec = { voice: new EngineVoice( this.ctx, panner, c.def, false ), panner };
				this.aiVoices.set( c, rec );
			}
			const p = c.root.position;
			const t = this.ctx.currentTime;
			rec.panner.positionX.setTargetAtTime( p.x, t, 0.05 ); rec.panner.positionY.setTargetAtTime( p.y, t, 0.05 ); rec.panner.positionZ.setTargetAtTime( p.z, t, 0.05 );
			// doppler from relative radial velocity
			const rel = c.vehicle.velocity.clone().sub( player.velocity );
			const dir = p.clone().sub( camera.position ).normalize();
			const vr = rel.dot( dir );
			const doppler = clamp( 343 / ( 343 + vr ), 0.8, 1.25 );
			const vol = clamp( 1 - d / 160, 0, 1 ) * 0.7;
			rec.voice.update( c.vehicle.engine.rpm, c.vehicle.engine.load, false, dt, vol, doppler );
		}
		for ( const [ c, rec ] of this.aiVoices ) if ( ! keep.has( c ) ) { rec.voice.disconnect(); rec.panner.disconnect(); this.aiVoices.delete( c ); }
	}

	impact( strength ) {
		if ( ! this.ready ) return;
		const ctx = this.ctx, t = ctx.currentTime;
		const s = ctx.createBufferSource(); s.buffer = this.white;
		const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime( 2500, t ); f.frequency.exponentialRampToValueAtTime( 200, t + 0.25 );
		const g = ctx.createGain(); g.gain.setValueAtTime( clamp( strength * 1.2, 0.1, 1 ), t ); g.gain.exponentialRampToValueAtTime( 0.0001, t + 0.35 );
		s.connect( f ); f.connect( g ); g.connect( this.sfx ); s.start( t ); s.stop( t + 0.4 );
		const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime( 90, t ); o.frequency.exponentialRampToValueAtTime( 35, t + 0.2 );
		const og = ctx.createGain(); og.gain.setValueAtTime( strength * 0.9, t ); og.gain.exponentialRampToValueAtTime( 0.0001, t + 0.3 );
		o.connect( og ); og.connect( this.sfx ); o.start( t ); o.stop( t + 0.35 );
	}

	/** UI blip. */
	blip( freq = 880, dur = 0.08, gain = 0.15 ) {
		if ( ! this.ready ) return;
		const ctx = this.ctx, t = ctx.currentTime;
		const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
		const g = ctx.createGain(); g.gain.setValueAtTime( gain, t ); g.gain.exponentialRampToValueAtTime( 0.0001, t + dur );
		o.connect( g ); g.connect( this.master ); o.start( t ); o.stop( t + dur + 0.02 );
	}
	countdownBeep( final ) { this.blip( final ? 1320 : 880, final ? 0.5 : 0.12, 0.2 ); }
}
