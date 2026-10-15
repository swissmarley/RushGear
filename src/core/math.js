/**
 * Rush Gear — core math helpers.
 *
 * Deterministic PRNG + procedural noise used by every generator in the game
 * (tracks, terrain, scenery, car details, audio). Nothing here touches three.js
 * so the same functions can be used from the physics thread and from mesh builders.
 */

export const clamp = ( v, a, b ) => ( v < a ? a : v > b ? b : v );
export const lerp = ( a, b, t ) => a + ( b - a ) * t;
export const smoothstep = ( a, b, x ) => {
	const t = clamp( ( x - a ) / ( b - a ), 0, 1 );
	return t * t * ( 3 - 2 * t );
};
export const sign = ( v ) => ( v < 0 ? - 1 : 1 );
export const DEG = Math.PI / 180;

/** Frame-rate independent exponential damping (Freya Holmér style). */
export const damp = ( a, b, lambda, dt ) => lerp( a, b, 1 - Math.exp( - lambda * dt ) );

/** Shortest-path angle difference in (-PI, PI]. */
export const angleDiff = ( a, b ) => {
	let d = ( b - a ) % ( Math.PI * 2 );
	if ( d > Math.PI ) d -= Math.PI * 2;
	if ( d < - Math.PI ) d += Math.PI * 2;
	return d;
};

/** Mulberry32 — small, fast, good enough for procedural content. */
export function makeRNG( seed ) {
	let s = seed >>> 0;
	const rng = () => {
		s = ( s + 0x6D2B79F5 ) >>> 0;
		let t = s;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
	rng.range = ( a, b ) => a + ( b - a ) * rng();
	rng.int = ( a, b ) => Math.floor( a + ( b - a + 1 ) * rng() );
	rng.pick = ( arr ) => arr[ Math.floor( rng() * arr.length ) ];
	rng.sign = () => ( rng() < 0.5 ? - 1 : 1 );
	return rng;
}

/** Integer hash → [0,1). */
export function hash2( x, y ) {
	let h = ( x * 374761393 + y * 668265263 ) | 0;
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;
}

export function hash3( x, y, z ) {
	let h = ( x * 374761393 + y * 668265263 + z * 2246822519 ) | 0;
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;
}

/** Smooth value noise in 2D, range [-1,1]. */
export function noise2( x, y ) {
	const xi = Math.floor( x ), yi = Math.floor( y );
	const xf = x - xi, yf = y - yi;
	const u = xf * xf * ( 3 - 2 * xf ), v = yf * yf * ( 3 - 2 * yf );
	const a = hash2( xi, yi ), b = hash2( xi + 1, yi ), c = hash2( xi, yi + 1 ), d = hash2( xi + 1, yi + 1 );
	return ( lerp( lerp( a, b, u ), lerp( c, d, u ), v ) ) * 2 - 1;
}

/** Fractal Brownian motion, range roughly [-1,1]. */
export function fbm2( x, y, octaves = 4, lacunarity = 2, gain = 0.5 ) {
	let sum = 0, amp = 1, norm = 0;
	for ( let i = 0; i < octaves; i ++ ) {
		sum += noise2( x, y ) * amp;
		norm += amp;
		amp *= gain;
		x = x * lacunarity + 17.3;
		y = y * lacunarity + 31.7;
	}
	return sum / norm;
}

/** Ridged noise — good for mountain silhouettes. */
export function ridged2( x, y, octaves = 4 ) {
	let sum = 0, amp = 0.5, norm = 0;
	for ( let i = 0; i < octaves; i ++ ) {
		const n = 1 - Math.abs( noise2( x, y ) );
		sum += n * n * amp;
		norm += amp;
		amp *= 0.5;
		x = x * 2.1 + 5.2;
		y = y * 2.1 + 1.3;
	}
	return sum / norm;
}

/** Format seconds as m:ss.mmm */
export function formatTime( t ) {
	if ( ! isFinite( t ) || t < 0 ) return '--:--.---';
	const m = Math.floor( t / 60 );
	const s = t - m * 60;
	return `${m}:${s.toFixed( 3 ).padStart( 6, '0' )}`;
}

export function formatDelta( d ) {
	if ( ! isFinite( d ) ) return '';
	return ( d >= 0 ? '+' : '-' ) + Math.abs( d ).toFixed( 3 );
}

export const ordinal = ( n ) => {
	const s = [ 'th', 'st', 'nd', 'rd' ], v = n % 100;
	return n + ( s[ ( v - 20 ) % 10 ] || s[ v ] || s[ 0 ] );
};
