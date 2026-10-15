/**
 * Shared GPU uniforms that every material/post effect can read.
 * Updated once per frame by the renderer from the sky/weather/time systems.
 */
import { uniform } from 'three/tsl';
import { Vector3, Color } from 'three/webgpu';

export const U = {
	time: uniform( 0 ),
	wetness: uniform( 0 ),        // 0 dry → 1 soaked (slow response to rain)
	rain: uniform( 0 ),           // current rain intensity
	rainLocal: uniform( 0 ),      // rain visible at the camera (0 inside tunnels)
	night: uniform( 0 ),          // 0 day → 1 night
	sunDir: uniform( new Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new Color( 1, 1, 1 ) ),
	sunIntensity: uniform( 1 ),
	skyZenith: uniform( new Color( 0.2, 0.4, 0.8 ) ),
	skyHorizon: uniform( new Color( 0.7, 0.8, 0.9 ) ),
	fogColor: uniform( new Color( 0.6, 0.7, 0.8 ) ),
	fogDensity: uniform( 0.002 ),
	fogHeight: uniform( 60 ),
	heat: uniform( 0 ),           // heat-haze strength (desert, hot exhaust)
	exposure: uniform( 1 ),
	cameraShake: uniform( 0 ),
	neon: uniform( 0 )            // city neon brightness (rises at night)
};
