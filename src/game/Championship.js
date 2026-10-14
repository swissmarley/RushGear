/**
 * Championship: a qualifying session sets the grid for round 1, then three races on three
 * circuits. Points: 25-18-15-12-10-8-6-4-2 (+1 fastest lap).
 */
import { Storage } from '../core/Storage.js';

const POINTS = [ 25, 18, 15, 12, 10, 8, 6, 4, 2 ];

export class Championship {
	constructor( trackIds, playerName, drivers ) {
		this.rounds = trackIds;
		this.round = 0;              // completed rounds
		this.stage = 'qualifying';   // qualifying | race
		this.points = new Map();     // name → points
		this.results = new Map();    // name → [positions]
		this.grid = null;            // name order for the next race
		this.drivers = drivers;      // [{name,isPlayer,color}]
		for ( const d of drivers ) { this.points.set( d.name, 0 ); this.results.set( d.name, [] ); }
		this.playerName = playerName;
		this.finished = false;
	}
	get currentTrack() { return this.rounds[ Math.min( this.round, this.rounds.length - 1 ) ]; }
	pointsFor( pos ) { return POINTS[ pos - 1 ] || 0; }
	nextLabel() { return this.stage === 'qualifying' ? 'Qualifying' : `Race ${this.round + 1}`; }

	/** Feed a finished session (Race instance). */
	submit( race ) {
		if ( race.mode === 'qualifying' ) {
			this.grid = race.standings.map( ( e ) => e.name );
			this.stage = 'race';
			return;
		}
		let fastest = null;
		for ( const e of race.standings ) {
			const pts = this.pointsFor( e.position );
			this.points.set( e.name, ( this.points.get( e.name ) || 0 ) + pts );
			this.results.get( e.name )?.push( e.position );
			if ( e.bestLap < Infinity && ( ! fastest || e.bestLap < fastest.bestLap ) ) fastest = e;
		}
		if ( fastest ) this.points.set( fastest.name, this.points.get( fastest.name ) + 1 );
		this.round ++;
		// next grid = reverse of... no: championship order decides the grid (leader on pole)
		this.grid = this.table().map( ( r ) => r.name );
		if ( this.round >= this.rounds.length ) this.finished = true;
		Storage.set( 'championship.last', { round: this.round, table: this.table() } );
	}

	table() {
		return this.drivers.map( ( d ) => ( { name: d.name, isPlayer: d.isPlayer, points: this.points.get( d.name ), results: this.results.get( d.name ) } ) )
			.sort( ( a, b ) => b.points - a.points || ( a.results[ 0 ] || 99 ) - ( b.results[ 0 ] || 99 ) );
	}
}
