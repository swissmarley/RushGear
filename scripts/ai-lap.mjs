import { Track } from '../src/world/Track.js';
import { getTrack, TRACKS } from '../src/world/TrackData.js';
import { Vehicle, DT } from '../src/vehicle/Vehicle.js';
import { getCar, CARS } from '../src/vehicle/CarData.js';
import { RacingLine } from '../src/ai/RacingLine.js';
import { AIDriver, AI_PERSONALITIES } from '../src/ai/AIDriver.js';
const trackId = process.argv[ 2 ] || 'azure', carId = process.argv[ 3 ] || 'vesper', laps = parseInt( process.argv[ 4 ] || '2' );
const track = new Track( getTrack( trackId ) );
const t0 = performance.now();
const line = new RacingLine( track );
const profile = line.buildSpeedProfile( getCar( carId ), track.def.weather.rain, { gripFactor: parseFloat( process.env.GRIP || '0.9' ) } );
console.log( `${trackId}: line optimised in ${( performance.now() - t0 ).toFixed( 0 )} ms; vmax ${( Math.max( ...profile.speed ) * 3.6 ).toFixed( 0 )} km/h, vmin ${( Math.min( ...profile.speed ) * 3.6 ).toFixed( 0 )} km/h, brake zones ${line.brakeZones.length}` );
const v = new Vehicle( getCar( carId ), track, { isPlayer: false } );
const slot = track.gridSlot( 0 );
v.reset( slot.x, slot.y, slot.z, slot.heading, slot.quaternion );
const ai = new AIDriver( v, line, profile, AI_PERSONALITIES[ 1 ], { seed: 3 } );
const race = { started: true, time: 0 };
let wasOff = false, lastS = v.proj.s, lap = 0, lapStart = 0, offTrack = 0, maxSpeed = 0, collisions = 0;
const lapTimes = [];
for ( let i = 0; i < 120 * 60 * 6; i ++ ) {
	ai.update( DT, race );
	v.step( DT, { wetness: track.def.weather.rain } );
	race.time += DT;
	collisions += v.collisions.length;
	maxSpeed = Math.max( maxSpeed, v.speedKmh );
	const isOff = Math.abs( v.proj.lateral ) > v.proj.width / 2 + 1.4;
	if ( isOff && ! wasOff ) console.log( `  off at s=${v.proj.s.toFixed( 0 )} v=${v.speedKmh.toFixed( 0 )} lat=${v.proj.lateral.toFixed( 1 )} tgt=${( profile.speedAt( v.proj.s ) * 3.6 ).toFixed( 0 )} slope=${( v.proj.ty * 100 ).toFixed( 1 )}% corner=${v.proj.corner >= 0 ? track.corners[ v.proj.corner ].name : '-'}` );
	wasOff = isOff;
	if ( isOff ) offTrack += DT;
	if ( v.proj.s - lastS < - track.length / 2 ) {
		if ( race.time < 5 ) { lastS = v.proj.s; lapStart = race.time; continue; }
		lap ++;
		lapTimes.push( race.time - lapStart );
		console.log( `lap ${lap}: ${( race.time - lapStart ).toFixed( 2 )} s  (off-track ${offTrack.toFixed( 1 )} s, collisions ${collisions}, max ${maxSpeed.toFixed( 0 )} km/h)` );
		lapStart = race.time; offTrack = 0; collisions = 0; maxSpeed = 0;
		if ( lap >= laps ) break;
	}
	lastS = v.proj.s;
	const win = process.env.WIN ? process.env.WIN.split( ',' ).map( Number ) : null;
	if ( win && v.proj.s > win[ 0 ] && v.proj.s < win[ 1 ] && i % 30 === 0 ) console.log( race.time.toFixed( 2 ), 's', v.proj.s.toFixed( 0 ), 'v', v.speedKmh.toFixed( 0 ), 'lat', v.proj.lateral.toFixed( 1 ), 'thr', v.controls.throttle.toFixed( 2 ), 'brk', v.controls.brake.toFixed( 2 ), 'steer', v.controls.steer.toFixed( 2 ), 'tgt', ( profile.speedAt( v.proj.s ) * 3.6 ).toFixed( 0 ), 'latG', v.lateralG.toFixed( 2 ), 'sa', v.wheels.map( ( w ) => ( w.slipAngle * 57.3 ).toFixed( 0 ) ).join( '/' ), 'surf', v.wheels.map( ( w ) => w.surface ).join( '' ), 'ground', v.wheels.map( ( w ) => w.onGround ? 1 : 0 ).join( '' ) );
	if ( i % ( 120 * 10 ) === 0 && process.argv.includes( '-v' ) ) console.log( race.time.toFixed( 0 ), 's', v.proj.s.toFixed( 0 ), 'v', v.speedKmh.toFixed( 0 ), 'lat', v.proj.lateral.toFixed( 1 ), 'mode', ai.mode, 'thr', v.controls.throttle.toFixed( 2 ), 'brk', v.controls.brake.toFixed( 2 ), 'steer', v.controls.steer.toFixed( 2 ), 'target', ( profile.speedAt( v.proj.s ) * 3.6 ).toFixed( 0 ) );
}
if ( lap < laps ) console.log( 'did not finish; s =', v.proj.s.toFixed( 0 ), 'speed', v.speedKmh.toFixed( 0 ), 'lat', v.proj.lateral.toFixed( 1 ) );
