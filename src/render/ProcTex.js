/**
 * Procedural texture helpers in TSL. Everything in the game is generated at runtime:
 * noise → albedo/roughness/normal. These helpers keep that code compact and consistent.
 */
import { Fn, vec3, float, positionView, normalView, cross, dot, sign, abs, normalize, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float, mix, smoothstep, fract, step, hash, floor } from 'three/tsl';

/**
 * Screen-space derivative bump mapping (Blinn's perturbNormalArb) for a procedural height.
 * `heightNode` must be an expression of position (world/local) so dFdx/dFdy are meaningful.
 * Returns a view-space normal suitable for material.normalNode.
 */
export const proceduralBump = Fn( ( [ heightNode, scale ] ) => {
	const h = float( heightNode ).mul( scale ).toVar();
	const dHdx = h.dFdx();
	const dHdy = h.dFdy();
	const sigmaX = positionView.dFdx();
	const sigmaY = positionView.dFdy();
	const n = normalView;
	const R1 = cross( sigmaY, n );
	const R2 = cross( n, sigmaX );
	const fDet = dot( sigmaX, R1 );
	const grad = sign( fDet ).mul( dHdx.mul( R1 ).add( dHdy.mul( R2 ) ) );
	return normalize( abs( fDet ).mul( n ).sub( grad ) );
} );

/** fbm in [0,1] */
export const fbm01 = Fn( ( [ p, octaves ] ) => {
	return mx_fractal_noise_float( p, octaves, 2.0, 0.5, 1.0 ).mul( 0.5 ).add( 0.5 );
} );

/** Cheap "cells" mask (puddles, patches) */
export const cells = Fn( ( [ p ] ) => mx_worley_noise_float( p, 1.0, 0 ) );

/** Stripe helper: 1 inside the first half of each period. */
export const stripe = Fn( ( [ x, period ] ) => step( 0.5, fract( x.div( period ) ) ) );

/** Random per-cell value for a 3D position quantized by `size` */
export const cellRandom = Fn( ( [ p, size ] ) => {
	const c = floor( p.div( size ) );
	return hash( c.x.add( c.y.mul( 57.0 ) ).add( c.z.mul( 113.0 ) ) );
} );

export { mx_noise_float as noise, mix, smoothstep, vec3, float };
