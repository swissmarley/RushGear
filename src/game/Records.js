/** Persistent best-lap records and ghost laps (localStorage). */
import { Storage } from '../core/Storage.js';

export class Records {
	constructor() {
		this.data = Storage.get( 'records', {} );
	}
	bestLap( trackId ) { return this.data[ trackId ] || null; }
	submit( trackId, time, carId, name ) {
		const cur = this.data[ trackId ];
		if ( ! cur || time < cur.time ) {
			this.data[ trackId ] = { time, carId, name, date: Date.now() };
			Storage.set( 'records', this.data );
			return true;
		}
		return false;
	}
	saveGhost( trackId, ghost ) { Storage.set( 'ghost.' + trackId, ghost ); }
	loadGhost( trackId ) { return Storage.get( 'ghost.' + trackId, null ); }
}
