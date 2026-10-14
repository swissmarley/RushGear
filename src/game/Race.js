/**
 * Race manager: countdown, lap/sector timing with checkpoint validation, live positions & gaps,
 * best-lap records, finish detection, and a live event feed (overtakes, fastest laps, crashes).
 */
import { formatTime, clamp } from '../core/math.js';
import { bus } from '../core/EventBus.js';

export class Race {
	/**
	 * @param opts { track, entries:[{vehicle,name,isPlayer,carName,color,ai}], laps, mode, records, timeLimit }
	 */
	constructor( opts ) {
		this.track = opts.track;
		this.laps = opts.laps ?? 3;
		this.mode = opts.mode ?? 'race'; // race | qualifying | timetrial
		this.records = opts.records;
		this.timeLimit = opts.timeLimit ?? 0;
		this.time = 0;
		this.countdown = this.mode === 'race' ? 3.6 : 0.8;
		this.state = 'countdown';
		this.record = this.records?.bestLap( this.track.id )?.time ?? Infinity;
		this.recordHolder = this.records?.bestLap( this.track.id )?.name ?? null;
		this.sessionBest = Infinity;
		this.sessionBestSectors = [ Infinity, Infinity, Infinity ];
		this.entries = opts.entries.map( ( e, i ) => ( {
			...e, index: i, lap: 1, position: i + 1, currentLapTime: 0, lastLap: Infinity, bestLap: Infinity, totalTime: 0,
			lapStart: 0, sectorStart: 0, sector: 0, sectorTimes: [ 0, 0, 0 ], bestSectors: [ Infinity, Infinity, Infinity ],
			sectorStatus: [ '', '', '' ], deltaToBest: null, wrongWay: false, wrongTimer: 0, finished: false, finishTime: Infinity,
			progress: 0, lastS: e.vehicle.proj?.s ?? 0, checkpoints: 0, gapText: '', lapTimes: [], valid: true, lapsDone: 0, offTrackTimer: 0,
			lastLapSplits: [ 0, 0, 0 ], bestLapSplits: null
		} ) );
		this.standings = this.entries.slice();
		this.finished = false;
		this.finishTimer = 0;
		this.player = this.entries.find( ( e ) => e.isPlayer ) || this.entries[ 0 ];
	}

	entryOf( vehicle ) { return this.entries.find( ( e ) => e.vehicle === vehicle ); }
	get isCountdown() { return this.state === 'countdown'; }
	get started() { return this.state !== 'countdown'; }

	update( dt ) {
		if ( this.state === 'countdown' ) {
			this.countdown -= dt;
			if ( this.countdown <= 0 ) { this.state = 'racing'; this.time = 0; for ( const e of this.entries ) { e.lapStart = 0; e.sectorStart = 0; } bus.emit( 'race:start' ); }
			return;
		}
		this.time += dt;
		const L = this.track.length;
		for ( const e of this.entries ) {
			const v = e.vehicle;
			const s = v.proj.s;
			if ( ! e.finished ) e.currentLapTime = this.time - e.lapStart;
			// progress for ordering: laps + fraction, but a car behind the line before it crosses counts as lap-1
			const ds = s - e.lastS;
			const crossedForward = ds < - L * 0.5;   // wrapped L → 0
			const crossedBackward = ds > L * 0.5;    // wrapped 0 → L (reversing over the line)
			// sector checkpoints (must be hit in order to validate a lap)
			const sec = s < this.track.sectors[ 0 ] ? 0 : s < this.track.sectors[ 1 ] ? 1 : 2;
			if ( ! e.finished ) {
				if ( sec === 1 && e.sector === 0 ) this._endSector( e, 0 );
				else if ( sec === 2 && e.sector === 1 ) this._endSector( e, 1 );
				if ( crossedForward ) {
					if ( e.sector === 2 && e.checkpoints >= 2 ) this._endLap( e );
					else { e.sector = 0; e.checkpoints = 0; e.sectorStart = this.time; }
				}
				if ( crossedBackward ) { e.checkpoints = 0; e.sector = 2; }
			}
			e.lastS = s;
			e.progress = ( e.lapsDone ) * L + s + ( crossedBackward ? - L : 0 );
			// wrong way detection
			const vt = v.velocity.x * v.proj.tx + v.velocity.z * v.proj.tz;
			if ( vt < - 3 ) e.wrongTimer += dt; else e.wrongTimer = Math.max( 0, e.wrongTimer - dt * 2 );
			e.wrongWay = e.wrongTimer > 1.2;
			// off-track (used for lap validity in qualifying/time trial)
			if ( Math.abs( v.proj.lateral ) > v.proj.width / 2 + 2.2 ) { e.offTrackTimer += dt; if ( e.offTrackTimer > 1.0 && this.mode !== 'race' ) e.valid = false; }
			else e.offTrackTimer = 0;
		}
		this._updateStandings();
		// finish conditions
		if ( this.mode === 'race' ) {
			if ( this.entries.every( ( e ) => e.finished ) ) this._finish();
			else if ( this.player.finished ) { this.finishTimer += dt; if ( this.finishTimer > 12 ) this._finish(); }
		} else if ( this.timeLimit > 0 && this.time > this.timeLimit ) {
			// session over once the player's current lap ends (or 20 s grace)
			this.finishTimer += dt;
			if ( this.finishTimer > 25 || this.entries.every( ( e ) => e.bestLap < Infinity ) && this.finishTimer > 0.1 ) this._finish();
		}
	}

	_endSector( e, i ) {
		const t = this.time - e.sectorStart;
		e.sectorTimes[ i ] = t;
		e.sectorStart = this.time;
		e.sector = i + 1;
		e.checkpoints = i + 1;
		let status = 'yellow';
		if ( t < this.sessionBestSectors[ i ] ) { status = 'purple'; this.sessionBestSectors[ i ] = t; }
		else if ( t < e.bestSectors[ i ] ) status = 'green';
		e.bestSectors[ i ] = Math.min( e.bestSectors[ i ], t );
		e.sectorStatus[ i ] = status;
		// delta vs personal best at this split
		if ( e.bestLapSplits ) e.deltaToBest = ( this.time - e.lapStart ) - e.bestLapSplits[ i ];
		if ( e.isPlayer ) bus.emit( 'race:sector', { entry: e, sector: i, time: t, status } );
	}

	_endLap( e ) {
		const lapTime = this.time - e.lapStart;
		e.sectorTimes[ 2 ] = this.time - e.sectorStart;
		let status = 'yellow';
		if ( e.sectorTimes[ 2 ] < this.sessionBestSectors[ 2 ] ) { status = 'purple'; this.sessionBestSectors[ 2 ] = e.sectorTimes[ 2 ]; }
		else if ( e.sectorTimes[ 2 ] < e.bestSectors[ 2 ] ) status = 'green';
		e.bestSectors[ 2 ] = Math.min( e.bestSectors[ 2 ], e.sectorTimes[ 2 ] );
		e.sectorStatus[ 2 ] = status;
		e.lastLap = lapTime;
		e.lapTimes.push( lapTime );
		e.lastLapSplits = [ e.sectorTimes[ 0 ], e.sectorTimes[ 0 ] + e.sectorTimes[ 1 ], lapTime ];
		const valid = e.valid || this.mode === 'race';
		if ( valid && lapTime < e.bestLap ) {
			e.bestLap = lapTime;
			e.bestLapSplits = e.lastLapSplits.slice();
			bus.emit( 'race:lap', { entry: e, time: lapTime, personalBest: true } );
		} else bus.emit( 'race:lap', { entry: e, time: lapTime, personalBest: false } );
		if ( valid && lapTime < this.sessionBest ) {
			this.sessionBest = lapTime;
			bus.emit( 'race:fastest', { entry: e, time: lapTime } );
		}
		if ( valid && this.records && lapTime < this.record ) {
			this.record = lapTime; this.recordHolder = e.name;
			this.records.submit( this.track.id, lapTime, e.vehicle.def.id, e.name );
			bus.emit( 'race:record', { entry: e, time: lapTime } );
		}
		if ( valid && e.isPlayer ) bus.emit( 'race:playerLap', { entry: e, time: lapTime, splits: e.lastLapSplits } );
		e.lapsDone ++;
		e.lap = e.lapsDone + 1;
		e.lapStart = this.time; e.sectorStart = this.time; e.sector = 0; e.checkpoints = 0; e.valid = true; e.deltaToBest = null;
		e.sectorStatus = [ '', '', '' ];
		if ( this.mode === 'race' && e.lapsDone >= this.laps && ! e.finished ) {
			e.finished = true; e.finishTime = this.time; e.totalTime = this.time;
			bus.emit( 'race:finish', { entry: e } );
		}
		if ( this.mode === 'race' && e.isPlayer && e.lapsDone === this.laps - 1 ) bus.emit( 'race:finalLap', { entry: e } );
	}

	_updateStandings() {
		const prev = this.standings.map( ( e ) => e );
		if ( this.mode === 'race' ) {
			this.standings.sort( ( a, b ) => {
				if ( a.finished && b.finished ) return a.finishTime - b.finishTime;
				if ( a.finished !== b.finished ) return a.finished ? - 1 : 1;
				return b.progress - a.progress;
			} );
		} else {
			this.standings.sort( ( a, b ) => ( a.bestLap - b.bestLap ) || ( a.index - b.index ) );
		}
		const leader = this.standings[ 0 ];
		for ( let i = 0; i < this.standings.length; i ++ ) {
			const e = this.standings[ i ];
			const oldPos = e.position;
			e.position = i + 1;
			if ( this.mode === 'race' ) {
				if ( i === 0 ) e.gapText = e.finished ? formatTime( e.totalTime ) : 'Leader';
				else if ( e.finished && leader.finished ) e.gapText = '+' + ( e.finishTime - leader.finishTime ).toFixed( 3 );
				else {
					const ahead = this.standings[ i - 1 ];
					const dist = ahead.progress - e.progress;
					const speed = Math.max( 10, e.vehicle.speed );
					const laps = Math.floor( dist / this.track.length );
					e.gapText = laps >= 1 ? `+${laps} lap${laps > 1 ? 's' : ''}` : '+' + ( dist / speed ).toFixed( 1 ) + 's';
				}
			} else {
				e.gapText = e.bestLap < Infinity ? ( i === 0 ? formatTime( e.bestLap ) : '+' + ( e.bestLap - leader.bestLap ).toFixed( 3 ) ) : '--';
			}
			// overtake events (racing only, after the first few seconds)
			if ( this.mode === 'race' && this.time > 4 && oldPos !== e.position && ! e.finished ) {
				if ( e.position < oldPos ) {
					const passed = prev.find( ( p ) => p.position === e.position && p !== e );
					if ( passed ) bus.emit( 'race:overtake', { entry: e, passed, position: e.position } );
				}
			}
		}
	}

	_finish() {
		if ( this.finished ) return;
		this.finished = true;
		this.state = 'finished';
		for ( const e of this.entries ) if ( ! e.finished ) { e.finished = this.mode !== 'race'; e.totalTime = this.time; }
		bus.emit( 'race:end', { race: this } );
	}

	/** Force a finish (used by qualifying time limits / menu quit). */
	end() { this._finish(); }
}
