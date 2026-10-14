/** localStorage wrapper with JSON + namespacing, tolerant of private-mode failures. */
const NS = 'rushgear.v1.';
export const Storage = {
	get( key, fallback = null ) {
		try {
			const v = localStorage.getItem( NS + key );
			return v === null ? fallback : JSON.parse( v );
		} catch { return fallback; }
	},
	set( key, value ) {
		try { localStorage.setItem( NS + key, JSON.stringify( value ) ); } catch { /* quota / private mode */ }
	},
	remove( key ) { try { localStorage.removeItem( NS + key ); } catch { /* ignore */ } }
};
